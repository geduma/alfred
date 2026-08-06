import { WebSocketServer, WebSocket } from 'ws';
import { ConfigLoader } from './config/loader';
import { LLMRouter } from './agent/llm-router';
import { PromptBuilder } from './agent/prompt-builder';
import { ChannelManager } from './channels/channel-manager';
import { getLogger } from './utils/logger';
import { ToolHandler } from './types/tool';
import { createTools } from './tools/index';
import { SessionStore, StoredSession } from './db/session-store';
import { JobSchedulerTool } from './tools/job-scheduler';
import { Message } from './types/llm';
import { ContextCompressor } from './services/context-compressor';
import { PromptCompressor } from './services/prompt-compressor';
import { VectorStoreManager } from './services/vector-store/index';
import { SnapshotManager } from './services/snapshot';
import { approximateSystemPromptTokens, estimateTokenCount } from './utils/token-counter';
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
const MAX_TOOL_ITERATIONS = 25;
const SAVE_DEBOUNCE_MS = 5000;
const TOOL_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_TOOLS = 3;

export class Gateway {
  private wss: WebSocketServer | null = null;
  private config: ConfigLoader;
  private llmRouter: LLMRouter;
  private promptBuilder: PromptBuilder;
  private channelManager: ChannelManager;
  private tools: ToolHandler[] = [];
  private cachedToolSchemas: any[] | null = null;
  private toolSchemaTokens: number = 0;
  private sessions: Map<string, StoredSession> = new Map();
  private sessionStore: SessionStore;
  private jobScheduler: JobSchedulerTool;
  private jobRunnerTimer: ReturnType<typeof setInterval> | null = null;
  private port: number;
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
    channelManager: ChannelManager
  ) {
    this.config = config;
    this.llmRouter = llmRouter;
    this.promptBuilder = promptBuilder;
    this.channelManager = channelManager;
    this.port = 18789;
    this.sessionStore = new SessionStore();
    this.jobScheduler = new JobSchedulerTool();
    this.rateLimiter = new RateLimiter();
    this.sessionRepo = new SessionRepository();
    this.messageRepo = new MessageRepository();
    this.commandRepo = new CommandRepository();
    this.contextCompressor = new ContextCompressor(config.memoryConfig);
    this.contextCompressor.setLlmRouter(llmRouter);
    this.contextCompressor.setContextBudget(this.getContextBudget());
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
    return createTools(this.config, this.healthMonitor, this.vectorStore, this.snapshotManager);
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

  private getContextBudget(): number {
    const memoryBudget = this.config.memoryConfig?.max_context_tokens || 32000;
    const provider = this.config.providers[this.config.llmConfig.primary_provider];
    const providerMax = provider?.config.max_context_tokens;
    if (!providerMax) return memoryBudget;
    return Math.min(memoryBudget, providerMax);
  }

  getHealthMonitor(): HealthMonitor | null {
    return this.healthMonitor;
  }

  getJobScheduler(): JobSchedulerTool {
    return this.jobScheduler;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws: WebSocket) => this.onClientConnect(ws));

    this.startJobRunner();
    await this.initServices();

    getLogger().info({ port: this.port }, 'Gateway WebSocket server started');

    this.skillLoader.startWatching();
    const initialSkills = await this.skillLoader.loadSkills();
    getLogger().info({ skillsLoaded: initialSkills.length }, 'Skills initialized');

    await this.channelManager.startAll();
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
    this.contextCompressor.setContextBudget(this.getContextBudget());

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
          if (this.wss) {
            this.wss.close();
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
      this.jobScheduler.fireDueJobs(this.channelManager);
    }, 30000);
    getLogger().info('Job runner started (30s interval)');
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
    currentMessage?: string
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

    if (this.vectorStore && currentMessage) {
      try {
        const results = await this.vectorStore.search(currentMessage);
        if (results.length > 0) {
          const ragContext = results
            .map(r => {
              const label = r.metadata.role === 'user' ? 'User' : r.metadata.role === 'assistant' ? 'Assistant' : 'Tool';
              return `[${label} — ${new Date(r.metadata.timestamp).toLocaleDateString()}]\n${r.text}`;
            })
            .join('\n\n');

          contextMessages = [
            { role: 'user', content: `[RAG CONTEXT — Retrieved from long-term memory]\n${ragContext}` },
            ...messages,
          ];

          getLogger().debug({ chunkCount: results.length }, 'RAG context injected');
        }
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'RAG search failed, continuing without');
      }
    }

    const compressedSystemPrompt = this.promptCompressor.compress(systemPrompt);

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

    const onMessage = async (data: Buffer) => {
      await this.onMessage(ws, data.toString());
    };

    const onClose = () => {
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
        default:
          this.sendError(ws, req.id, `Unknown method: ${req.method}`);
      }
    } catch (error: any) {
      getLogger().error({ error: error.message }, 'Message processing error');
      this.sendError(ws, 'unknown', error.message);
    }
  }

  private handleConnect(ws: WebSocket, req: GatewayRequest): void {
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
    _onEvent: (event: string, payload: any) => void
  ): Promise<{ content: string; toolCalls: any[]; usage: any }> {
    let finalSystem = systemPrompt;
    let messages = contextMessages;
    let finalContent = '';
    let allToolCalls: any[] = [];
    let totalUsage: any = undefined;
    let iteration = 0;

    const maxIterations = this.config.allConfig.agent.max_tool_iterations || MAX_TOOL_ITERATIONS;
    while (iteration < maxIterations) {
      const response = await this.llmRouter.call({
        messages,
        system: finalSystem,
        tools: this.getToolSchemas(),
      });

      if (!response.tool_calls || response.tool_calls.length === 0) {
        finalContent = response.content || '';
        totalUsage = response.usage;
        break;
      }

      allToolCalls = allToolCalls.concat(response.tool_calls);

      const assistantToolMsg: Message = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      };
      session.messages.push(assistantToolMsg);
      await this.ingestMessage(session, assistantToolMsg, ingestParams);

      const executeTool = async (toolCall: any): Promise<void> => {
        const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
        if (!tool) {
          const errorMsg: Message = { role: 'tool', content: `Tool "${toolCall.function.name}" not found or disabled`, tool_call_id: toolCall.id };
          session.messages.push(errorMsg);
          return;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
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

      for (let i = 0; i < response.tool_calls.length; i += MAX_CONCURRENT_TOOLS) {
        const batch = response.tool_calls.slice(i, i + MAX_CONCURRENT_TOOLS);
        await Promise.all(batch.map(tc => executeToolWithTimeout(tc)));
      }

      iteration++;
      const contextResult = await this.prepareContext(session, finalSystem);
      messages = contextResult.messages;
      finalSystem = contextResult.systemPrompt;
    }

    if (iteration >= maxIterations && !finalContent) {
      finalContent = 'Reached maximum tool call iterations. Please refine your request.';
    }

    return { content: finalContent, toolCalls: allToolCalls, usage: totalUsage };
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

    try {
      const userMsg: Message = { role: 'user', content: message };
      session.messages.push(userMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'user', message);
      const [systemPrompt, skillsContext] = await Promise.all([
        this.promptBuilder.buildSystemPrompt(),
        this.loadSkillsContext(),
        this.ingestMessage(session, userMsg, ingestParams),
      ]);

      const finalSkillsPrompt = skillsContext
        ? `${systemPrompt}\n\n## Available Skills\n${skillsContext}`
        : systemPrompt;

      const { messages: contextMessages, systemPrompt: finalSystem } = await this.prepareContext(session, finalSkillsPrompt, message);

      const { content, toolCalls, usage } = await this.runAgentLoop(
        session, finalSystem, contextMessages, ingestParams,
        () => {} // no-op for WebSocket events
      );

      const assistantMsg: Message = { role: 'assistant', content };
      session.messages.push(assistantMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'assistant', content);
      await this.ingestMessage(session, assistantMsg, ingestParams);
      await this.checkAutoSnapshot(session);
      this.debounceSave(session);

      this.sendEvent(ws, 'agent_complete', {
        runId,
        content,
        toolCalls,
        usage,
      });
    } catch (error: any) {
      getLogger().error({ error: error.message, runId }, 'Agent request failed');
      try {
        this.sendError(ws, req.id, `Agent error: ${error.message}`);
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
    const rateLimit = this.config.security?.rate_limiting;
    if (rateLimit) {
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

    try {
      const userMsg: Message = { role: 'user', content: params.content };
      session.messages.push(userMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'user', params.content);
      const [systemPrompt, skillsContext] = await Promise.all([
        this.promptBuilder.buildSystemPrompt(),
        this.loadSkillsContext(),
        this.ingestMessage(session, userMsg, ingestParams),
      ]);

      const finalSkillsPrompt = skillsContext
        ? `${systemPrompt}\n\n## Available Skills\n${skillsContext}`
        : systemPrompt;

      const { messages: contextMessages, systemPrompt: finalSystem } = await this.prepareContext(session, finalSkillsPrompt, params.content);

      const { content } = await this.runAgentLoop(
        session, finalSystem, contextMessages, ingestParams,
        () => {}
      );

      const assistantMsg: Message = { role: 'assistant', content };
      session.messages.push(assistantMsg);
      void this.persistMessage(this.dbSessionIds.get(session.id), 'assistant', content);
      await this.ingestMessage(session, assistantMsg, ingestParams);
      await this.checkAutoSnapshot(session);
      this.debounceSave(session);
      return content;
    } catch (error: any) {
      getLogger().error({ error: error.message, runId }, 'Message processing failed');
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