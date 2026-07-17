import path from 'path';
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
import { approximateSystemPromptTokens } from './utils/token-counter';
import { HealthMonitor } from './services/health-monitor';
import { NotificationService } from './services/notification';
import { RateLimiter } from './security/rate-limiter';
import { TaskDecomposer } from './services/task-decomposer';
import { ToolOrchestrator } from './services/tool-orchestrator';
import { SkillLoader } from './services/skill-loader';

interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const MAX_SESSIONS = 100;
const MAX_TOOL_ITERATIONS = 3;
const SAVE_DEBOUNCE_MS = 5000;

export class Gateway {
  private wss: WebSocketServer | null = null;
  private config: ConfigLoader;
  private llmRouter: LLMRouter;
  private promptBuilder: PromptBuilder;
  private channelManager: ChannelManager;
  private tools: ToolHandler[] = [];
  private cachedToolSchemas: any[] | null = null;
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
  private taskDecomposer: TaskDecomposer;
  private toolOrchestrator: ToolOrchestrator;
  private skillLoader: SkillLoader;
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
    this.contextCompressor = new ContextCompressor(config.memoryConfig);
    this.contextCompressor.setLlmRouter(llmRouter);
    this.promptCompressor = new PromptCompressor(config.memoryConfig?.prompt_compression);
    this.taskDecomposer = new TaskDecomposer();
    this.taskDecomposer.setLlmRouter(llmRouter);
    this.toolOrchestrator = new ToolOrchestrator();
    this.skillLoader = new SkillLoader(path.resolve(__dirname, '../../.opencode/skills'));

    const vectorStoreConfig = config.memoryConfig?.vector_store;
    if (vectorStoreConfig?.enabled) {
      this.vectorStore = new VectorStoreManager(vectorStoreConfig, config.providers);
    }

    const snapshotConfig = config.memoryConfig?.snapshots;
    if (snapshotConfig?.enabled) {
      this.snapshotManager = new SnapshotManager(snapshotConfig);
    }

    const healthConfig = config.healthMonitor;
    if (healthConfig?.enabled) {
      const notifier = new NotificationService(healthConfig, this.channelManager);
      const logDir = config.logging.config.file_path || '/workspace/logs';
      this.healthMonitor = new HealthMonitor(healthConfig, notifier, path.join(logDir, 'alfred.log'));
    }
  }

  setTools(tools: ToolHandler[]): void {
    this.tools = tools;
    this.cachedToolSchemas = null;
    this.toolOrchestrator.setTools(tools);
  }

  private getToolSchemas(): any[] {
    if (!this.cachedToolSchemas) {
      this.cachedToolSchemas = this.tools.map(t => t.tool);
    }
    return this.cachedToolSchemas;
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

    getLogger().info({ port: this.port }, 'Gateway WebSocket server started');

    if (this.healthMonitor) {
      this.healthMonitor.start();
      const newTools = createTools(this.config, this.healthMonitor, this.vectorStore, this.snapshotManager);
      this.setTools(newTools);
      getLogger().info({ tools: newTools.map(t => t.tool.name) }, 'Tools updated with health monitor');
    }

    this.skillLoader.startWatching();
    const initialSkills = await this.skillLoader.loadSkills();
    getLogger().info({ skillsLoaded: initialSkills.length }, 'Skills initialized');

    await this.channelManager.startAll();
  }

  async stop(): Promise<void> {
    this.stopJobRunner();
    await this.flushPendingSaves();
    this.rateLimiter.stop();
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
    if (this.wss) {
      this.wss.close();
    }
    await this.channelManager.stopAll();
    getLogger().info('Gateway stopped');
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
    let messages = session.messages;

    if (this.contextCompressor.shouldCompact(session.messages, systemPromptTokens)) {
      const result = await this.contextCompressor.compactSession(
        session.summary,
        session.messages,
        systemPromptTokens
      );

      if (result.wasCompacted) {
        session.summary = result.summary;
        session.messages = result.messages;
        messages = result.messages;
      }
    }

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
      gateway: { version: '2.0.0' },
    });
  }

  private async runAgentLoop(
    session: StoredSession,
    systemPrompt: string,
    contextMessages: Message[],
    ingestParams: { channel: string; userId: string },
    _onEvent: (event: string, payload: any) => void
  ): Promise<{ content: string; toolCalls: any[]; usage: any }> {
    let finalSystem = systemPrompt;
    let messages = contextMessages;
    let finalContent = '';
    let allToolCalls: any[] = [];
    let totalUsage: any = undefined;
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
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

      const toolExecutionPromises = response.tool_calls.map(async (toolCall) => {
        const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
        if (!tool) return null;

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          const errorMsg: Message = { role: 'tool', content: `Invalid JSON in tool arguments: ${toolCall.function.arguments}`, tool_call_id: toolCall.id };
          session.messages.push(errorMsg);
          return null;
        }

        if (tool.validate) {
          const validation = tool.validate(args);
          if (!validation.success) {
            const errorMsg: Message = { role: 'tool', content: `Tool validation error: ${(validation.errors || []).join(', ')}`, tool_call_id: toolCall.id };
            session.messages.push(errorMsg);
            return null;
          }
        }

        let lastError: string | undefined;
        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            const result = await tool.execute(args);
            const toolMsg: Message = { role: 'tool', content: result.output, tool_call_id: toolCall.id };
            session.messages.push(toolMsg);
            await this.ingestMessage(session, toolMsg, ingestParams);
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
        return undefined;
      });

      await Promise.all(toolExecutionPromises);

      iteration++;
      const contextResult = await this.prepareContext(session, finalSystem);
      messages = contextResult.messages;
      finalSystem = contextResult.systemPrompt;
    }

    if (iteration >= MAX_TOOL_ITERATIONS && !finalContent) {
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

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ingestParams = { channel: 'ws', userId: sessionKey };

    try {
      const userMsg: Message = { role: 'user', content: message };
      session.messages.push(userMsg);
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

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ingestParams = { channel: params.channel, userId: params.userId };

    try {
      const userMsg: Message = { role: 'user', content: params.content };
      session.messages.push(userMsg);
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

      this.config.reload();
      log.info('Config reloaded from disk');

      this.llmRouter.reinitialize(this.config);
      log.info('LLM router reinitialized');

      const personalityFile = this.config.personalityFile;
      try {
        await this.promptBuilder.reload(personalityFile);
        log.info('SOUL.md reloaded');
      } catch (error: any) {
        log.warn({ error: error.message }, 'SOUL.md reload failed, using cached');
      }

      const memoryConfig = this.config.memoryConfig;
      if (memoryConfig) {
        this.contextCompressor.updateConfig(memoryConfig);
        this.promptCompressor.updateConfig(memoryConfig.prompt_compression || { enabled: true, mode: 'telegraph' });
      }

      const newTools = createTools(this.config);
      this.setTools(newTools);
      log.info({ tools: newTools.map(t => t.tool.name) }, 'Tools reloaded');

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