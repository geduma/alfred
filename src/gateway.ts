import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { ConfigLoader } from './config/loader';
import { LLMRouter } from './agent/llm-router';
import { PromptBuilder } from './agent/prompt-builder';
import { ChannelManager } from './channels/channel-manager';
import { WebChannel } from './channels/web';
import { getLogger } from './utils/logger';
import { ToolHandler } from './types/tool';
import { createTools } from './tools/index';
import { SessionStore, StoredSession } from './db/session-store';
import { JobSchedulerTool, Job } from './tools/job-scheduler';
import { Message, LLMResponse } from './types/llm';
import { ContextCompressor } from './services/context-compressor';
import { PromptCompressor } from './services/prompt-compressor';
import { VectorStoreManager } from './services/vector-store/index';
import { SnapshotManager } from './services/snapshot';
import { approximateSystemPromptTokens, estimateTokenCount, estimateMessagesTokens } from './utils/token-counter';
import { isThrottleError, parseRequestedTokens, nextContextBudget, MIN_CONTEXT_BUDGET, isBudgetBlockedError } from './utils/provider-errors';
import { HealthMonitor } from './services/health-monitor';
import { NotificationService } from './services/notification';
import { RateLimiter } from './security/rate-limiter';
import { SkillLoader } from './services/skill-loader';
import { SessionRepository } from './db/repositories/sessions';
import { MessageRepository } from './db/repositories/messages';
import { CommandRepository } from './db/repositories/commands';
import { isDatabaseInitialized } from './db/index';
import { SystemTool } from './tools/system';
import { WORKSPACE_PATHS } from './utils/workspace';

interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const MAX_SESSIONS = 100;
const MAX_TOOL_ITERATIONS = 12;
const MAX_HALLUCINATED_ROUNDS = 3;
const MAX_TRACE_BYTES = 65536;
const SAVE_DEBOUNCE_MS = 5000;
const TOOL_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_TOOLS = 3;
const MAX_ADAPTIVE_ATTEMPTS = 3;
const MIN_OUTPUT_TOKENS = 512;
const AGENT_JOB_MIN_INTERVAL_MS = 30 * 60 * 1000;
const AGENT_JOB_MIN_REMAINING_PERCENT = 10;

export class Gateway {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private webChannel: WebChannel | null = null;
  private config: ConfigLoader;
  private llmRouter: LLMRouter;
  private promptBuilder: PromptBuilder;
  private channelManager: ChannelManager;
  private tools: ToolHandler[] = [];
  private cachedToolSchemas: any[] | null = null;
  private toolSchemaTokens: number = 0;
  private providerContextBudgets: Map<string, number> = new Map();
  private sessions: Map<string, StoredSession> = new Map();
  private sessionStore: SessionStore;
  private jobScheduler: JobSchedulerTool;
  private jobRunnerTimer: ReturnType<typeof setInterval> | null = null;
  private lastAgentJobFire: Map<string, number> = new Map();
  private port: number;
  private host: string;
  private contextCompressor: ContextCompressor;
  private promptCompressor: PromptCompressor;
  private vectorStore: VectorStoreManager | null = null;
  private snapshotManager: SnapshotManager | null = null;
  private healthMonitor: HealthMonitor | null = null;
  private rateLimiter: RateLimiter;
  private skillLoader: SkillLoader;
  private sessionRepo: SessionRepository;
  private messageRepo: MessageRepository;
  private commandRepo: CommandRepository;
  private dbSessionIds: Map<string, string> = new Map();
  private wsSessions: Map<WebSocket, string> = new Map();
  private connectionLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private pendingSaves: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    config: ConfigLoader,
    llmRouter: LLMRouter,
    promptBuilder: PromptBuilder,
    channelManager: ChannelManager,
    webChannel?: WebChannel | null
  ) {
    this.config = config;
    this.llmRouter = llmRouter;
    this.promptBuilder = promptBuilder;
    this.channelManager = channelManager;
    this.webChannel = webChannel || null;
    this.port = config.serverConfig.port;
    this.host = config.serverConfig.host;
    this.sessionStore = new SessionStore();
    this.jobScheduler = new JobSchedulerTool();
    this.rateLimiter = new RateLimiter();
    this.sessionRepo = new SessionRepository();
    this.messageRepo = new MessageRepository();
    this.commandRepo = new CommandRepository();
    this.contextCompressor = new ContextCompressor(config.memoryConfig);
    this.contextCompressor.setLlmRouter(llmRouter);
    this.loadProviderBudgets();
    this.refreshProviderBudgets();
    this.promptCompressor = new PromptCompressor(config.memoryConfig?.prompt_compression);
    this.skillLoader = new SkillLoader(WORKSPACE_PATHS.skills());

    this.buildServices();
  }

  setTools(tools: ToolHandler[]): void {
    this.tools = tools;
    this.cachedToolSchemas = null;
    this.toolSchemaTokens = 0;
    this.wireSystemReload();
  }

  private buildTools(): ToolHandler[] {
    return createTools(
      this.config,
      this.healthMonitor,
      this.vectorStore,
      this.snapshotManager,
      this.llmRouter.getBudgetTracker(),
      this.llmRouter
    );
  }

  private buildServices(): void {
    const vectorStoreConfig = this.config.memoryConfig?.vector_store;
    if (vectorStoreConfig?.enabled) {
      this.vectorStore = new VectorStoreManager(vectorStoreConfig, this.config.providers);
    } else {
      this.vectorStore = null;
    }

    const snapshotConfig = this.config.memoryConfig?.snapshots;
    if (snapshotConfig?.enabled) {
      this.snapshotManager = new SnapshotManager(snapshotConfig);
    } else {
      this.snapshotManager = null;
    }

    const healthConfig = this.config.healthMonitor;
    if (healthConfig?.enabled) {
      const notifier = new NotificationService(healthConfig, this.channelManager);
      const logPath = this.config.logging.config.file_path || WORKSPACE_PATHS.alfredLog();
      this.healthMonitor = new HealthMonitor(healthConfig, notifier, logPath);
    } else {
      this.healthMonitor = null;
    }
  }

  private wireSystemReload(): void {
    const systemTool = this.tools.find((t): t is SystemTool => t instanceof SystemTool);
    if (systemTool) {
      systemTool.setReloadHandler(() => this.reload());
    }
  }

  private getToolSchemas(): any[] {
    if (!this.cachedToolSchemas) {
      this.cachedToolSchemas = this.tools.map(t => t.tool);
    }
    return this.cachedToolSchemas;
  }

  private getToolSchemaTokens(): number {
    if (this.toolSchemaTokens === 0 && this.getToolSchemas().length > 0) {
      this.toolSchemaTokens = estimateTokenCount(JSON.stringify(this.getToolSchemas()));
    }
    return this.toolSchemaTokens;
  }

  private traceEnabled(): boolean {
    return this.config.allConfig.agent.trace === true;
  }

  private writeAgentTrace(entry: Record<string, unknown>): void {
    if (!this.traceEnabled()) return;
    try {
      const dir = WORKSPACE_PATHS.logs();
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      fs.appendFileSync(path.join(dir, 'agent-traces.jsonl'), `${line}\n`, 'utf-8');
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Agent trace write failed');
    }
  }

  private serializeToolSchemasForTrace(): { names: string[]; hash: string } {
    const schemas = this.getToolSchemas().map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
    const hash = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
    return { names: schemas.map(s => s.function.name), hash };
  }

  private truncateForTrace(value: unknown, maxBytes = MAX_TRACE_BYTES): unknown {
    const raw = JSON.stringify(value);
    if (raw === undefined) return undefined;
    if (raw.length <= maxBytes) return value;
    return { truncated: true, snippet: raw.slice(0, maxBytes) };
  }

  private getContextBudget(): number {
    const memoryBudget = this.config.memoryConfig?.max_context_tokens || 32000;
    const providerName = this.config.llmConfig.primary_provider;
    const learned = this.providerContextBudgets.get(providerName);
    return Math.max(MIN_CONTEXT_BUDGET, Math.min(memoryBudget, learned ?? memoryBudget));
  }

  private getOutputTokens(): number {
    const provider = this.config.providers[this.config.llmConfig.primary_provider];
    const configured = provider?.config.max_tokens ?? 4096;
    const derived = Math.floor(this.getContextBudget() * 0.35);
    return Math.max(MIN_OUTPUT_TOKENS, Math.min(configured, derived));
  }

  private loadProviderBudgets(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(WORKSPACE_PATHS.providerBudgets(), 'utf-8'));
      if (raw && typeof raw === 'object') {
        for (const [name, value] of Object.entries(raw)) {
          if (typeof value === 'number' && value >= MIN_CONTEXT_BUDGET) {
            this.providerContextBudgets.set(name, value);
          }
        }
      }
    } catch {
      // no saved budgets yet
    }
  }

  private saveProviderBudgets(): void {
    const data: Record<string, number> = {};
    for (const [name, value] of this.providerContextBudgets) {
      data[name] = value;
    }
    void fs.promises.writeFile(WORKSPACE_PATHS.providerBudgets(), JSON.stringify(data, null, 2), 'utf-8').catch(() => {
      // persistence is best-effort
    });
  }

  private refreshProviderBudgets(): void {
    for (const [name, provider] of Object.entries(this.config.providers)) {
      if (!provider.enabled) continue;
      const configured = provider.config.max_context_tokens;
      if (configured) {
        const current = this.providerContextBudgets.get(name);
        if (!current || configured < current) {
          this.providerContextBudgets.set(name, configured);
        }
      }
    }
    this.contextCompressor.setContextBudget(this.getContextBudget());
  }

  private shrinkContextBudget(errorMessage: string): number {
    const providerName = this.config.llmConfig.primary_provider;
    const current = this.providerContextBudgets.get(providerName) ?? this.getContextBudget();
    const requested = parseRequestedTokens(errorMessage);
    const next = nextContextBudget(current, requested);
    this.providerContextBudgets.set(providerName, next);
    this.contextCompressor.setContextBudget(this.getContextBudget());
    this.saveProviderBudgets();
    getLogger().warn(
      { provider: providerName, from: current, to: next, requested },
      'Reduced provider context budget after request-too-large'
    );
    return next;
  }

  getHealthMonitor(): HealthMonitor | null {
    return this.healthMonitor;
  }

  getJobScheduler(): JobSchedulerTool {
    return this.jobScheduler;
  }

  private async checkDegraded(): Promise<{ active: boolean; reason?: 'daily_limit' | 'monthly_limit' }> {
    const limits = this.config.llmConfig.spending_limits;
    if (!limits?.enabled || limits.on_limit_reached !== 'block_all') {
      return { active: false };
    }
    const budget = await this.llmRouter.getBudgetTracker().checkBudget();
    if (!budget.allowed) {
      return { active: true, reason: budget.reason };
    }
    return { active: false };
  }

  private buildDegradedMessage(reason?: string): string {
    if (reason === 'daily_limit') {
      return "Alfred is in degraded service mode: the daily token budget has been exhausted. Please try again tomorrow.";
    }
    return "Alfred is in degraded service mode: the monthly token budget has been exhausted. Please try again next month.";
  }

  private async getBudgetRemainingPercent(): Promise<number | null> {
    const limits = this.config.llmConfig.spending_limits;
    if (!limits?.enabled) return null;
    const budget = await this.llmRouter.getBudgetTracker().checkBudget();
    return budget.remainingPercent;
  }

  private async checkBudgetAlert(): Promise<void> {
    try {
      const warning = await this.llmRouter.getBudgetTracker().evaluateWarning();
      if (!warning) return;

      const healthConfig = this.config.healthMonitor;
      if (!healthConfig?.enabled) return;

      const notifier = new NotificationService(healthConfig, this.channelManager);
      const usage = await this.llmRouter.getBudgetTracker().getTokenUsage();
      const limits = this.config.llmConfig.spending_limits;

      if (warning === 'daily') {
        const pct = limits?.daily_token_limit ? Math.round((usage.today / limits.daily_token_limit) * 100) : 0;
        await notifier.sendAlert(
          'Daily token budget near limit',
          `Current usage: ${usage.today.toLocaleString()} tokens (${pct}% of the daily limit).`,
          'warn'
        );
      } else {
        const pct = limits?.monthly_token_limit ? Math.round((usage.thisMonth / limits.monthly_token_limit) * 100) : 0;
        await notifier.sendAlert(
          'Monthly token budget near limit',
          `Current usage: ${usage.thisMonth.toLocaleString()} tokens (${pct}% of the monthly limit).`,
          'warn'
        );
      }
    } catch (error: any) {
      getLogger().debug({ error: error.message }, 'Budget alert check failed');
    }
  }

  async start(): Promise<void> {
    this.httpServer = http.createServer((req, res) => this.handleStaticRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url || '/';
      const isWeb = url === '/ws' || url.startsWith('/ws?') || url.startsWith('/ws/');
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        if (isWeb) {
          (ws as any).webClient = true;
          getLogger().debug('Web client upgrade accepted (path-routed /ws, no auth yet — TODO)');
        }
        this.wss!.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => this.onClientConnect(ws));
    this.httpServer.listen(this.port, this.host);

    this.startJobRunner();
    await this.initServices();

    getLogger().info({ port: this.port, host: this.host }, 'Gateway HTTP + WebSocket server started');

    this.skillLoader.startWatching();
    const initialSkills = await this.skillLoader.loadSkills();
    getLogger().info({ skillsLoaded: initialSkills.length }, 'Skills initialized');

    await this.channelManager.startAll();
  }

  private handleStaticRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url || '/').split('?')[0];
    const webDir = path.resolve(__dirname, '../web');
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(webDir, rel);

    if (!filePath.startsWith(webDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  private async initServices(): Promise<void> {
    if (this.vectorStore) {
      try {
        await this.vectorStore.initialize();
        getLogger().info('Vector store initialized');
      } catch (error: any) {
        getLogger().warn(
          { error: { message: error.message, code: error.code, stack: error.stack } },
          'Vector store init failed, RAG disabled'
        );
        this.vectorStore = null;
      }
    }

    if (this.healthMonitor) {
      this.healthMonitor.start();
    }

    this.setTools(this.buildTools());
    getLogger().info({ tools: this.tools.map(t => t.tool.name) }, 'Tools registered');
  }

  async reload(): Promise<void> {
    await this.config.reload();
    getLogger().info('Config reloaded from disk');

    this.llmRouter.reinitialize(this.config);
    getLogger().info('LLM router reinitialized');

    const personalityFile = this.config.personalityFile;
    try {
      await this.promptBuilder.reload(personalityFile);
      getLogger().info('SOUL.md reloaded');
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'SOUL.md reload failed, using cached');
    }

    const memoryConfig = this.config.memoryConfig;
    if (memoryConfig) {
      this.contextCompressor.updateConfig(memoryConfig);
      this.promptCompressor.updateConfig(memoryConfig.prompt_compression || { enabled: true, mode: 'telegraph' });
    }
    this.refreshProviderBudgets();

    await this.rebuildServicesAndTools();
  }

  private async rebuildServicesAndTools(): Promise<void> {
    if (this.healthMonitor) {
      this.healthMonitor.stop();
      this.healthMonitor = null;
    }
    if (this.vectorStore) {
      try {
        await this.vectorStore.close();
      } catch { /* ignore */ }
      this.vectorStore = null;
    }
    this.snapshotManager = null;

    this.buildServices();
    await this.initServices();
  }

  async stop(): Promise<void> {
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timed out after 10s')), 10_000);
    });

    try {
      await Promise.race([
        (async () => {
          this.stopJobRunner();
          this.skillLoader.stopWatching();
          if (this.healthMonitor) {
            this.healthMonitor.stop();
          }
          await this.flushPendingSaves();
          this.rateLimiter.stop();
          if (this.vectorStore) {
            await this.vectorStore.close();
          }
          if (this.webChannel) {
            await this.webChannel.stop();
          }
          if (this.wss) {
            this.wss.close();
          }
          if (this.httpServer) {
            await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
          }
          await this.channelManager.stopAll();
        })(),
        timeout,
      ]);
      getLogger().info('Gateway stopped');
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Gateway stop timed out, forcing shutdown');
    }
  }

  private async flushPendingSaves(): Promise<void> {
    for (const [sessionId, timer] of this.pendingSaves) {
      clearTimeout(timer);
      const session = this.sessions.get(sessionId);
      if (session) {
        await this.sessionStore.save(session);
      }
    }
    this.pendingSaves.clear();
  }

  private debounceSave(session: StoredSession): void {
    const existing = this.pendingSaves.get(session.id);
    if (existing) clearTimeout(existing);
    this.pendingSaves.set(session.id, setTimeout(async () => {
      try {
        await this.sessionStore.save(session);
      } catch (error: any) {
        getLogger().error({ error: error.message, sessionId: session.id }, 'Debounced save failed');
      }
      this.pendingSaves.delete(session.id);
    }, SAVE_DEBOUNCE_MS));
  }

  private evictSession(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()]
      .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (oldest) {
      this.sessions.delete(oldest[0]);
    }
  }

  private startJobRunner(): void {
    this.jobRunnerTimer = setInterval(() => {
      this.jobScheduler.fireDueJobs(this.channelManager, (job) => this.handleAgentJobFire(job));
    }, 30000);
    getLogger().info('Job runner started (30s interval)');
  }

  private async handleAgentJobFire(job: Job): Promise<void> {
    const { channel, user_id, chat_id } = job.created_by;
    const metadata = chat_id !== undefined ? { chat_id } : undefined;

    if (await this.skipAgentJob(job)) {
      return;
    }

    const content = await this.processMessage({
      channel,
      userId: user_id,
      userName: undefined,
      content: job.message,
      sessionId: `${channel}_${user_id}_jobs`,
      metadata: { source: 'job', jobId: job.id },
    });

    if (content) {
      await this.channelManager.sendMessage(channel, user_id, content, metadata);
    }
  }

  private async skipAgentJob(job: Job): Promise<boolean> {
    const now = Date.now();
    const last = this.lastAgentJobFire.get(job.id);
    const metadata = job.created_by.chat_id !== undefined ? { chat_id: job.created_by.chat_id } : undefined;

    if (last !== undefined && now - last < AGENT_JOB_MIN_INTERVAL_MS) {
      getLogger().warn({ jobId: job.id, skip_reason: 'min_interval' }, 'Agent job skipped (min interval)');
      await this.channelManager.sendMessage(
        job.created_by.channel,
        job.created_by.user_id,
        'Skipped: minimum interval between agent runs for this job has not elapsed.',
        metadata
      );
      return true;
    }

    const budgetTracker = this.llmRouter?.getBudgetTracker?.();
    if (budgetTracker) {
      const budget = await budgetTracker.checkBudget();
      if (!budget.allowed || budget.remainingPercent < AGENT_JOB_MIN_REMAINING_PERCENT) {
        getLogger().warn(
          { jobId: job.id, skip_reason: 'budget', remainingPercent: budget.remainingPercent, reason: budget.reason },
          'Agent job skipped (budget)'
        );
        await this.channelManager.sendMessage(
          job.created_by.channel,
          job.created_by.user_id,
          'Skipped: token budget for this period is exhausted or near its limit.',
          metadata
        );
        return true;
      }
    }

    this.lastAgentJobFire.set(job.id, now);
    return false;
  }

  private stopJobRunner(): void {
    if (this.jobRunnerTimer) {
      clearInterval(this.jobRunnerTimer);
      this.jobRunnerTimer = null;
    }
  }

  private async prepareContext(
    session: StoredSession,
    systemPrompt: string,
    currentMessage?: string,
    skipCompression = false
  ): Promise<{ messages: Message[]; systemPrompt: string }> {
    const budgetPercent = await this.getBudgetRemainingPercent();
    if (budgetPercent !== null && budgetPercent < 20) {
      this.contextCompressor.setThresholdOverride(0.6);
    }

    try {
      return await this.prepareContextInner(session, systemPrompt, currentMessage, skipCompression);
    } finally {
      this.contextCompressor.clearThresholdOverride();
    }
  }

  private async prepareContextInner(
    session: StoredSession,
    systemPrompt: string,
    currentMessage?: string,
    skipCompression = false
  ): Promise<{ messages: Message[]; systemPrompt: string }> {
    const systemPromptTokens = approximateSystemPromptTokens(systemPrompt);
    const extraTokens = this.getToolSchemaTokens();
    let messages = session.messages;

    if (this.contextCompressor.shouldCompact(session.messages, systemPromptTokens, extraTokens)) {
      const result = await this.contextCompressor.compactSession(
        session.summary,
        session.messages,
        systemPromptTokens,
        extraTokens
      );

      if (result.wasCompacted) {
        session.summary = result.summary;
        session.messages = result.messages;
        messages = result.messages;
      }
    }

    this.ensureToolResponses(session.messages);

    let contextMessages: Message[] = messages;
    let ragTokens = 0;

    if (this.vectorStore && currentMessage) {
      try {
        const results = await this.vectorStore.search(currentMessage, undefined, { excludeSessionId: session.id });
        if (results.length > 0) {
          const ragContext = results
            .map(r => {
              const label = r.metadata.role === 'user' ? 'User' : r.metadata.role === 'assistant' ? 'Assistant' : 'Tool';
              return `[${label} — ${new Date(r.metadata.timestamp).toLocaleDateString()}]\n${r.text}`;
            })
            .join('\n\n');

          ragTokens = estimateTokenCount(ragContext);

          contextMessages = [
            { role: 'user', content: `[RAG CONTEXT — Retrieved from long-term memory]\n${ragContext}` },
            ...messages,
          ];

          getLogger().debug({ chunkCount: results.length, ragTokens }, 'RAG context injected');
        }
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'RAG search failed, continuing without');
      }
    }

    const compressedSystemPrompt = skipCompression
      ? systemPrompt
      : this.promptCompressor.compress(systemPrompt);

    getLogger().debug(
      {
        component: 'req_payload',
        sessionId: session.id,
        systemTokens: systemPromptTokens,
        toolTokens: extraTokens,
        messagesTokens: estimateMessagesTokens(contextMessages),
        ragTokens,
        totalEstimateTokens: systemPromptTokens + extraTokens + estimateMessagesTokens(contextMessages),
        messageCount: contextMessages.length,
      },
      'LLM request payload estimate'
    );

    return { messages: contextMessages, systemPrompt: compressedSystemPrompt };
  }

  private ensureToolResponses(messages: Message[]): void {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.tool_calls || m.tool_calls.length === 0) continue;

      const responded = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === 'tool' && next.tool_call_id) {
          responded.add(next.tool_call_id);
        } else if (next.role === 'assistant') {
          break;
        }
      }

      const missing = m.tool_calls.filter(tc => !responded.has(tc.id));
      if (missing.length === 0) continue;

      const synthetic: Message[] = missing.map(tc => ({
        role: 'tool' as const,
        content: `Tool error: "${tc.function.name}" produced no result.`,
        tool_call_id: tc.id,
      }));

      messages.splice(i + 1, 0, ...synthetic);
      getLogger().warn(
        { toolCallIds: missing.map(tc => tc.id) },
        'Repaired dangling tool_calls in session history'
      );
      i += synthetic.length;
    }
  }

  private async loadSkillsContext(): Promise<string> {
    try {
      const skills = await this.skillLoader.loadSkills();
      return this.skillLoader.getSkillsContext(skills);
    } catch {
      return '';
    }
  }

  private async ingestMessage(session: StoredSession, msg: Message, params: { channel: string; userId: string }): Promise<void> {
    if (!this.vectorStore) return;
    const ingestConfig = this.config.memoryConfig?.vector_store?.ingest;
    if (ingestConfig && ingestConfig.on_message === false) return;
    if (!msg.content || msg.content.trim().length < 10) return;

    try {
      await this.vectorStore.ingest(msg.content, {
        sessionId: session.id,
        channel: params.channel,
        userId: params.userId,
        timestamp: new Date().toISOString(),
        role: msg.role,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
    } catch {
      // silent — ingestion failure should not break the conversation flow
    }
  }

  private async checkAutoSnapshot(session: StoredSession): Promise<void> {
    if (!this.snapshotManager) return;

    if (this.snapshotManager.shouldAutoSnapshot(session.id, session.messages.length)) {
      try {
        await this.snapshotManager.create(session);
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'Auto-snapshot failed');
      }
    }
  }

  private async trackSqlSession(params: {
    sessionKey: string;
    channel: string;
    userId: string;
    userName?: string;
  }): Promise<void> {
    if (!isDatabaseInitialized()) return;
    try {
      const record = await this.sessionRepo.getOrCreate(params.channel, params.userId, params.userName);
      await this.sessionRepo.updateActivity(record.id);
      this.dbSessionIds.set(params.sessionKey, record.id);
    } catch (error: any) {
      getLogger().debug({ error: error.message }, 'SQLite session tracking skipped');
    }
  }

  private async persistMessage(sqlSessionId: string | undefined, role: 'user' | 'assistant', content: string): Promise<void> {
    if (!sqlSessionId || !isDatabaseInitialized()) return;
    try {
      await this.messageRepo.save(sqlSessionId, role, content);
    } catch (error: any) {
      getLogger().debug({ error: error.message }, 'SQLite message persistence skipped');
    }
  }

  private async logExecCommand(
    session: StoredSession,
    userId: string,
    args: Record<string, unknown>,
    result: { output: string; exitCode?: number; duration_ms?: number }
  ): Promise<void> {
    if (!isDatabaseInitialized()) return;
    const sqlSessionId = this.dbSessionIds.get(session.id);
    if (!sqlSessionId) return;

    try {
      await this.commandRepo.log({
        sessionId: sqlSessionId,
        userId,
        command: (args.command as string) || '',
        result: result.output || undefined,
        exitCode: result.exitCode,
        durationMs: result.duration_ms,
      });
    } catch (error: any) {
      getLogger().debug({ error: error.message }, 'SQLite command log skipped');
    }
  }

  private onClientConnect(ws: WebSocket): void {
    const ip = (ws as any)._socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const connRecord = this.connectionLimits.get(ip);
    if (connRecord && now < connRecord.resetAt) {
      connRecord.count++;
      if (connRecord.count > 20) {
        getLogger().warn({ ip }, 'Connection rate limit exceeded');
        ws.close(1013, 'Too many connections');
        return;
      }
    } else {
      this.connectionLimits.set(ip, { count: 1, resetAt: now + 60_000 });
    }

    getLogger().debug('New WebSocket client connected');

    if ((ws as any).webClient && this.webChannel) {
      this.webChannel.addClient(ws);
    }

    const onMessage = async (data: Buffer) => {
      await this.onMessage(ws, data.toString());
    };

    const onClose = () => {
      if ((ws as any).webClient && this.webChannel) {
        this.webChannel.removeClient(ws);
      }
      this.wsSessions.delete(ws);
      ws.off('message', onMessage);
      ws.off('error', onError);
      getLogger().debug('WebSocket client disconnected');
    };

    const onError = (error: Error) => {
      getLogger().error({ error: error.message }, 'WebSocket error');
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  }

  private async onMessage(ws: WebSocket, data: string): Promise<void> {
    try {
      const req: GatewayRequest = JSON.parse(data);

      switch (req.method) {
        case 'connect':
          this.handleConnect(ws, req);
          break;
        case 'agent':
          await this.handleAgentRequest(ws, req);
          break;
        case 'tool_list':
          this.handleToolList(ws);
          break;
        case 'reload':
          await this.handleReload(ws, req);
          break;
        case 'config_get':
          this.handleConfigGet(ws, req);
          break;
        case 'config_update':
          await this.handleConfigUpdate(ws, req);
          break;
        default:
          this.sendError(ws, req.id, `Unknown method: ${req.method}`);
      }
    } catch (error: any) {
      getLogger().error({ error: error.message }, 'Message processing error');
      this.sendError(ws, 'unknown', error.message);
    }
  }

  private handleConnect(ws: WebSocket, req: GatewayRequest): void {
    if ((ws as any).webClient) {
      // TODO: add authentication for the web channel before exposing it publicly.
      this.sendResponse(ws, req.id, {
        status: 'connected',
        webClient: true,
        gateway: { version: this.config.allConfig.agent.version },
      });
      return;
    }

    const auth = req.params?.auth as { token?: string; sessionId?: string } | undefined;
    const authToken = auth?.token;

    if (!authToken || authToken !== this.config.security.gateway_auth_token) {
      this.sendError(ws, req.id, 'Invalid auth token');
      ws.close();
      return;
    }

    if (auth?.sessionId) {
      this.wsSessions.set(ws, auth.sessionId);
    }

    this.sendResponse(ws, req.id, {
      status: 'connected',
      gateway: { version: this.config.allConfig.agent.version },
    });
  }

  private async runAgentLoop(
    session: StoredSession,
    systemPrompt: string,
    contextMessages: Message[],
    ingestParams: { channel: string; userId: string; metadata?: Record<string, unknown> },
    runId: string,
    _onEvent: (event: string, payload: any) => void
  ): Promise<{ content: string; toolCalls: any[]; usage: any }> {
    let finalSystem = systemPrompt;
    let messages = contextMessages;
    let finalContent = '';
    let allToolCalls: any[] = [];
    let totalUsage: any = undefined;
    let iteration = 0;
    let consecutiveBadRounds = 0;

    const source = ingestParams.metadata?.source === 'job' ? 'job' : 'interactive';
    const toolSchemasForTrace = this.serializeToolSchemasForTrace();

    const maxIterations = this.config.allConfig.agent.max_tool_iterations || MAX_TOOL_ITERATIONS;
    while (iteration < maxIterations) {
      const round = iteration + 1;
      this.writeAgentTrace({
        component: 'round_start',
        runId,
        round,
        source,
        messageCount: messages.length,
        systemTokens: approximateSystemPromptTokens(finalSystem),
        toolSchemaHash: toolSchemasForTrace.hash,
        toolNames: toolSchemasForTrace.names,
        maxTokens: this.getOutputTokens(),
      });

      const response = await this.callWithAdaptiveRetry(session, messages, finalSystem);

      const parsedToolCalls = response.tool_calls || [];
      this.writeAgentTrace({
        component: 'round_end',
        runId,
        round,
        source,
        model: response.model,
        stop_reason: response.stop_reason,
        usage: response.usage,
        toolCalls: parsedToolCalls,
        raw: this.truncateForTrace(response.raw),
      });

      if (parsedToolCalls.length === 0) {
        finalContent = response.content || '';
        totalUsage = response.usage;
        break;
      }

      allToolCalls = allToolCalls.concat(parsedToolCalls);

      const assistantToolMsg: Message = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: parsedToolCalls,
      };
      session.messages.push(assistantToolMsg);
      await this.ingestMessage(session, assistantToolMsg, ingestParams);

      let roundBad = false;

      const executeTool = async (toolCall: any): Promise<void> => {
        const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
        if (!tool) {
          roundBad = true;
          getLogger().warn(
            { runId, round, toolName: toolCall.function.name },
            'Agent loop: unknown tool name in tool_calls'
          );
          this.writeAgentTrace({
            component: 'suspicious_round',
            runId,
            round,
            source,
            reason: 'unknown_tool_name',
            toolName: toolCall.function.name,
            arguments: toolCall.function.arguments,
            raw: this.truncateForTrace(response.raw),
          });
          const errorMsg: Message = { role: 'tool', content: `Tool "${toolCall.function.name}" not found or disabled`, tool_call_id: toolCall.id };
          session.messages.push(errorMsg);
          return;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          roundBad = true;
          getLogger().warn(
            { runId, round, toolName: toolCall.function.name },
            'Agent loop: invalid JSON in tool arguments'
          );
          const errorMsg: Message = { role: 'tool', content: `Invalid JSON in tool arguments: ${toolCall.function.arguments}`, tool_call_id: toolCall.id };
          session.messages.push(errorMsg);
          return;
        }

        if (tool.validate) {
          const validation = tool.validate(args);
          if (!validation.success) {
            const errorMsg: Message = { role: 'tool', content: `Tool validation error: ${(validation.errors || []).join(', ')}`, tool_call_id: toolCall.id };
            session.messages.push(errorMsg);
            return;
          }
        }

        let lastError: string | undefined;
        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            const execArgs = (toolCall.function.name === 'exec' || toolCall.function.name === 'job')
              ? { ...args, __context: { channel: ingestParams.channel, userId: ingestParams.userId, chat_id: ingestParams.metadata?.chat_id } }
              : args;
            const result = await tool.execute(execArgs);
            const toolMsg: Message = { role: 'tool', content: result.output, tool_call_id: toolCall.id };
            session.messages.push(toolMsg);
            await this.ingestMessage(session, toolMsg, ingestParams);
            if (toolCall.function.name === 'exec') {
              await this.logExecCommand(session, ingestParams.userId, args, result);
            }
            return;
          } catch (toolError: any) {
            lastError = toolError.message;
            if (attempt === 0) {
              const retryMsg: Message = { role: 'tool', content: `[RETRY] Tool error: ${toolError.message}. Retrying...`, tool_call_id: toolCall.id };
              session.messages.push(retryMsg);
            }
          }
        }

        const errorMsg: Message = { role: 'tool', content: `Tool execution error: ${lastError}`, tool_call_id: toolCall.id };
        session.messages.push(errorMsg);
      };

      const executeToolWithTimeout = async (toolCall: any): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool ${toolCall.function.name} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS);
        });

        try {
          await Promise.race([executeTool(toolCall), timeout]);
        } catch (error: any) {
          const errorMsg: Message = { role: 'tool', content: `Tool error: ${error.message}`, tool_call_id: toolCall.id };
          session.messages.push(errorMsg);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      for (let i = 0; i < parsedToolCalls.length; i += MAX_CONCURRENT_TOOLS) {
        const batch = parsedToolCalls.slice(i, i + MAX_CONCURRENT_TOOLS);
        await Promise.all(batch.map(tc => executeToolWithTimeout(tc)));
      }

      consecutiveBadRounds = roundBad ? consecutiveBadRounds + 1 : 0;

      if (consecutiveBadRounds >= MAX_HALLUCINATED_ROUNDS) {
        finalContent = source === 'job'
          ? '⚠️ Límite de iteraciones alcanzado por tool calls inválidos. Revisar manualmente.'
          : 'Reached the iteration limit due to repeated invalid tool calls. Please review manually.';
        totalUsage = response.usage;
        getLogger().warn(
          { runId, round, consecutiveBadRounds },
          'Agent loop broken: repeated invalid tool calls'
        );
        break;
      }

      iteration++;
      const contextResult = await this.prepareContext(session, finalSystem, undefined, true);
      messages = contextResult.messages;
      finalSystem = contextResult.systemPrompt;
    }

    if (iteration >= maxIterations && !finalContent) {
      finalContent = source === 'job'
        ? '⚠️ Límite de iteraciones alcanzado. Revisar manualmente.'
        : 'Reached maximum tool call iterations. Please refine your request.';
      getLogger().warn({ runId, iterations: iteration }, 'Agent loop reached max iterations');
    }

    return { content: finalContent, toolCalls: allToolCalls, usage: totalUsage };
  }

  private async callWithAdaptiveRetry(
    session: StoredSession,
    messages: Message[],
    system: string
  ): Promise<LLMResponse> {
    let attempt = 0;
    let callMessages = messages;
    const callSystem = system;
    let tools = this.getToolSchemas();

    for (;;) {
      try {
        return await this.llmRouter.call({
          messages: callMessages,
          system: callSystem,
          tools,
          max_tokens: this.getOutputTokens(),
        });
      } catch (error: any) {
        if (!isThrottleError(error.message)) throw error;

        if (attempt >= MAX_ADAPTIVE_ATTEMPTS) {
          if (tools.length > 0) {
            tools = [];
            getLogger().warn(
              { provider: this.config.llmConfig.primary_provider },
              'Context too large even after compaction, retrying without tools'
            );
            continue;
          }
          throw error;
        }

        attempt++;
        this.shrinkContextBudget(error.message);

        const systemPromptTokens = approximateSystemPromptTokens(callSystem);
        const extraTokens = this.getToolSchemaTokens();
        const result = await this.contextCompressor.compactSession(
          session.summary,
          session.messages,
          systemPromptTokens,
          extraTokens,
          true
        );
        if (result.wasCompacted) {
          session.summary = result.summary;
          session.messages = result.messages;
        }
        this.ensureToolResponses(session.messages);
        callMessages = session.messages;

        getLogger().warn(
          { attempt, budget: this.getContextBudget() },
          'Compacting context after request-too-large and retrying'
        );
      }
    }
  }

  private async handleAgentRequest(ws: WebSocket, req: GatewayRequest): Promise<void> {
    const { message, sessionId } = req.params as { message: string; sessionId: string };

    if (!message) {
      this.sendError(ws, req.id, 'Message is required');
      return;
    }

    const allowedSession = this.wsSessions.get(ws);
    if (allowedSession && sessionId && sessionId !== allowedSession) {
      this.sendError(ws, req.id, 'Session ID does not match your authenticated session');
      return;
    }

    const rateLimit = this.config.security?.rate_limiting;
    if (rateLimit) {
      if (!this.rateLimiter.checkUser(sessionId || 'default', rateLimit.requests_per_user_per_hour || 100)) {
        this.sendError(ws, req.id, 'Rate limit exceeded for user');
        return;
      }
      if (!this.rateLimiter.checkChannel('ws', rateLimit.requests_per_channel_per_hour || 1000)) {
        this.sendError(ws, req.id, 'Rate limit exceeded for channel');
        return;
      }
    }

    const sessionKey = sessionId || 'default';
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = await this.sessionStore.getOrCreate(sessionKey);
      this.evictSession();
      this.sessions.set(sessionKey, session);
    }

    await this.trackSqlSession({
      sessionKey: session.id,
      channel: 'ws',
      userId: sessionKey,
    });

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ingestParams = { channel: 'ws', userId: sessionKey };

    const degraded = await this.checkDegraded();
    if (degraded.active) {
      const content = this.buildDegradedMessage(degraded.reason);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'user', message);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'assistant', content);
      this.sendEvent(ws, 'agent_complete', {
        runId,
        content,
        toolCalls: [],
        usage: undefined,
        degraded: true,
      });
      return;
    }

    try {
      const userMsg: Message = { role: 'user', content: message };
      session.messages.push(userMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'user', message);
      const [systemPrompt, skillsContext] = await Promise.all([
        this.promptBuilder.buildSystemPrompt(),
        this.loadSkillsContext(),
      ]);

      const finalSkillsPrompt = skillsContext
        ? `${systemPrompt}\n\n## Available Skills\n${skillsContext}`
        : systemPrompt;

      const { messages: contextMessages, systemPrompt: finalSystem } = await this.prepareContext(session, finalSkillsPrompt, message);
      await this.ingestMessage(session, userMsg, ingestParams);

      const { content, toolCalls, usage } = await this.runAgentLoop(
        session, finalSystem, contextMessages, ingestParams,
        runId,
        () => {} // no-op for WebSocket events
      );

      const assistantMsg: Message = { role: 'assistant', content };
      session.messages.push(assistantMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'assistant', content);
      await this.ingestMessage(session, assistantMsg, ingestParams);
      await this.checkAutoSnapshot(session);
      this.debounceSave(session);
      await this.checkBudgetAlert();

      this.sendEvent(ws, 'agent_complete', {
        runId,
        content,
        toolCalls,
        usage,
      });
    } catch (error: any) {
      getLogger().error({ error: error.message, runId }, 'Agent request failed');
      try {
        if (isBudgetBlockedError(error)) {
          this.sendEvent(ws, 'agent_complete', {
            runId,
            content: this.buildDegradedMessage(),
            toolCalls: [],
            usage: undefined,
            degraded: true,
          });
        } else {
          this.sendError(ws, req.id, `Agent error: ${error.message}`);
        }
      } catch { /* connection may be closed */ }
    }
  }

  async processMessage(params: {
    channel: string;
    userId: string;
    userName?: string;
    content: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): Promise<string | null> {
    const isJobTriggered = params.metadata?.source === 'job';
    const rateLimit = this.config.security?.rate_limiting;
    if (rateLimit && !isJobTriggered) {
      if (!this.rateLimiter.checkUser(params.userId, rateLimit.requests_per_user_per_hour || 100)) {
        getLogger().warn({ userId: params.userId }, 'Rate limit exceeded for user');
        return 'Rate limit exceeded. Please wait before sending another message.';
      }
      if (!this.rateLimiter.checkChannel(params.channel, rateLimit.requests_per_channel_per_hour || 1000)) {
        getLogger().warn({ channel: params.channel }, 'Rate limit exceeded for channel');
        return 'Rate limit exceeded for this channel. Please wait.';
      }
    }

    const sessionKey = params.sessionId || `${params.channel}_${params.userId}`;
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = await this.sessionStore.getOrCreate(sessionKey);
      this.evictSession();
      this.sessions.set(sessionKey, session);
    }

    await this.trackSqlSession({
      sessionKey: session.id,
      channel: params.channel,
      userId: params.userId,
      userName: params.userName,
    });

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ingestParams = { channel: params.channel, userId: params.userId, metadata: params.metadata };

    const degraded = await this.checkDegraded();
    if (degraded.active) {
      void this.persistMessage(this.dbSessionIds.get(session.id), 'user', params.content);
      const content = this.buildDegradedMessage(degraded.reason);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'assistant', content);
      return content;
    }

    try {
      const userMsg: Message = { role: 'user', content: params.content };
      session.messages.push(userMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'user', params.content);
      const [systemPrompt, skillsContext] = await Promise.all([
        this.promptBuilder.buildSystemPrompt(),
        this.loadSkillsContext(),
      ]);

      const finalSkillsPrompt = skillsContext
        ? `${systemPrompt}\n\n## Available Skills\n${skillsContext}`
        : systemPrompt;

      const { messages: contextMessages, systemPrompt: finalSystem } = await this.prepareContext(session, finalSkillsPrompt, params.content);
      await this.ingestMessage(session, userMsg, ingestParams);

      const { content } = await this.runAgentLoop(
        session, finalSystem, contextMessages, ingestParams,
        runId,
        () => {}
      );

      const assistantMsg: Message = { role: 'assistant', content };
      session.messages.push(assistantMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'assistant', content);
      await this.ingestMessage(session, assistantMsg, ingestParams);
      await this.checkAutoSnapshot(session);
      this.debounceSave(session);
      await this.checkBudgetAlert();
      return content;
    } catch (error: any) {
      getLogger().error({ error: error.message, runId }, 'Message processing failed');
      if (isBudgetBlockedError(error)) {
        return this.buildDegradedMessage();
      }
      return `I'm sorry. An error occurred: ${error.message}`;
    }
  }

  private async handleReload(ws: WebSocket, req: GatewayRequest): Promise<void> {
    try {
      const log = getLogger();

      log.info('Hot-reload triggered via WebSocket');

      await this.reload();

      this.sendResponse(ws, req.id, {
        status: 'reloaded',
        config: true,
        llmRouter: true,
        promptBuilder: true,
        tools: true,
      });
    } catch (error: any) {
      getLogger().error({ error: error.message }, 'Hot-reload failed');
      this.sendError(ws, req.id, `Reload failed: ${error.message}`);
    }
  }

  private handleToolList(ws: WebSocket): void {
    const toolList = this.tools.map(t => ({
      name: t.tool.name,
      description: t.tool.description,
      enabled: true,
    }));

    this.sendResponse(ws, 'tool_list', { tools: toolList });
  }

  private handleConfigGet(ws: WebSocket, req: GatewayRequest): void {
    const raw = this.config.allConfig;
    this.sendResponse(ws, req.id, { config: this.sanitizeConfig(raw) });
  }

  private async handleConfigUpdate(ws: WebSocket, req: GatewayRequest): Promise<void> {
    const patch = req.params?.config;
    if (!patch || typeof patch !== 'object') {
      this.sendError(ws, req.id, 'config object is required');
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.config.configPathValue, 'utf-8'));
      const merged = this.deepMerge(raw, patch);
      await this.config.writeRaw(merged);
      this.sendResponse(ws, req.id, {
        status: 'saved',
        message: 'Configuration saved. Use "reload" to apply changes.',
      });
    } catch (error: any) {
      getLogger().error({ error: error.message }, 'Config update failed');
      this.sendError(ws, req.id, `Config update failed: ${error.message}`);
    }
  }

  private sanitizeConfig(raw: any): any {
    const redacted = JSON.parse(JSON.stringify(raw));
    if (redacted.providers) {
      for (const name of Object.keys(redacted.providers)) {
        const config = redacted.providers[name]?.config;
        if (config?.api_key) {
          config.api_key = '*****';
        }
      }
    }
    if (redacted.security?.gateway_auth_token) {
      redacted.security.gateway_auth_token = '*****';
    }
    return redacted;
  }

  private deepMerge(base: any, patch: any): any {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
        out[key] = this.deepMerge(base[key], value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private sendResponse(ws: WebSocket, id: string, payload: unknown): void {
    ws.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
  }

  private sendEvent(ws: WebSocket, event: string, payload: unknown): void {
    ws.send(JSON.stringify({ type: 'event', event, payload }));
  }

  private sendError(ws: WebSocket, id: string, message: string): void {
    ws.send(JSON.stringify({ type: 'error', id, message }));
  }
}