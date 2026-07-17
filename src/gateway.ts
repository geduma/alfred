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

interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export class Gateway {
  private wss: WebSocketServer | null = null;
  private config: ConfigLoader;
  private llmRouter: LLMRouter;
  private promptBuilder: PromptBuilder;
  private channelManager: ChannelManager;
  private tools: ToolHandler[] = [];
  private sessions: Map<string, StoredSession> = new Map();
  private sessionStore: SessionStore;
  private jobScheduler: JobSchedulerTool;
  private jobRunnerTimer: ReturnType<typeof setInterval> | null = null;
  private port: number;
  private contextCompressor: ContextCompressor;
  private promptCompressor: PromptCompressor;
  private vectorStore: VectorStoreManager | null = null;
  private snapshotManager: SnapshotManager | null = null;

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
    this.contextCompressor = new ContextCompressor(config.memoryConfig);
    this.contextCompressor.setLlmRouter(llmRouter);
    this.promptCompressor = new PromptCompressor(config.memoryConfig?.prompt_compression);

    const vectorStoreConfig = config.memoryConfig?.vector_store;
    if (vectorStoreConfig?.enabled) {
      this.vectorStore = new VectorStoreManager(vectorStoreConfig, config.providers);
    }

    const snapshotConfig = config.memoryConfig?.snapshots;
    if (snapshotConfig?.enabled) {
      this.snapshotManager = new SnapshotManager(snapshotConfig);
    }
  }

  setTools(tools: ToolHandler[]): void {
    this.tools = tools;
  }

  getJobScheduler(): JobSchedulerTool {
    return this.jobScheduler;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws: WebSocket) => this.onClientConnect(ws));

    this.loadSessions();
    this.startJobRunner();

    if (this.vectorStore) {
      try {
        await this.vectorStore.initialize();
        getLogger().info('Vector store initialized');
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'Vector store init failed, RAG disabled');
        this.vectorStore = null;
      }
    }

    getLogger().info({ port: this.port }, 'Gateway WebSocket server started');

    await this.channelManager.startAll();
  }

  async stop(): Promise<void> {
    this.stopJobRunner();
    if (this.vectorStore) {
      await this.vectorStore.close();
    }
    if (this.wss) {
      this.wss.close();
    }
    await this.channelManager.stopAll();
    getLogger().info('Gateway stopped');
  }

  private loadSessions(): void {
    const stored = this.sessionStore.listActive();
    for (const session of stored) {
      this.sessions.set(session.id, session);
    }
    getLogger().info({ sessionCount: stored.length }, 'Sessions loaded from disk');
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
    getLogger().debug('New WebSocket client connected');

    ws.on('message', async (data: Buffer) => {
      await this.onMessage(ws, data.toString());
    });

    ws.on('close', () => {
      getLogger().debug('WebSocket client disconnected');
    });

    ws.on('error', (error: Error) => {
      getLogger().error({ error: error.message }, 'WebSocket error');
    });
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
    const auth = req.params?.auth as { token?: string } | undefined;
    const authToken = auth?.token;

    if (authToken && authToken !== this.config.security.gateway_auth_token) {
      this.sendError(ws, req.id, 'Invalid auth token');
      ws.close();
      return;
    }

    this.sendResponse(ws, req.id, {
      status: 'connected',
      gateway: { version: '2.0.0' },
    });
  }

  private async handleAgentRequest(ws: WebSocket, req: GatewayRequest): Promise<void> {
    const { message, sessionId } = req.params as { message: string; sessionId: string };

    if (!message) {
      this.sendError(ws, req.id, 'Message is required');
      return;
    }

    const sessionKey = sessionId || 'default';
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = this.sessionStore.getOrCreate(sessionKey);
      this.sessions.set(sessionKey, session);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ingestParams = { channel: 'ws', userId: sessionKey };

    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt();

      session.messages.push({ role: 'user', content: message });
      await this.ingestMessage(session, session.messages[session.messages.length - 1], ingestParams);

      const { messages: contextMessages, systemPrompt: finalSystem } = await this.prepareContext(session, systemPrompt, message);

      const response = await this.llmRouter.call({
        messages: contextMessages,
        system: finalSystem,
        tools: this.tools.map(t => t.tool),
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
          const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
          if (tool) {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await tool.execute(args);
            const toolMsg: Message = { role: 'tool', content: result.output, tool_call_id: toolCall.id };
            session.messages.push(toolMsg);
            await this.ingestMessage(session, toolMsg, ingestParams);
          }
        }

        const { messages: finalContextMessages, systemPrompt: finalSystemAgain } = await this.prepareContext(session, finalSystem);

        const finalResponse = await this.llmRouter.call({
          messages: finalContextMessages,
          system: finalSystemAgain,
        });

        const assistantMsg: Message = { role: 'assistant', content: finalResponse.content };
        session.messages.push(assistantMsg);
        await this.ingestMessage(session, assistantMsg, ingestParams);
        await this.checkAutoSnapshot(session);
        this.sessionStore.save(session);

        this.sendEvent(ws, 'agent_complete', {
          runId,
          content: finalResponse.content,
          toolCalls: response.tool_calls,
          usage: finalResponse.usage,
        });
      } else {
        const assistantMsg: Message = { role: 'assistant', content: response.content };
        session.messages.push(assistantMsg);
        await this.ingestMessage(session, assistantMsg, ingestParams);
        await this.checkAutoSnapshot(session);
        this.sessionStore.save(session);

        this.sendEvent(ws, 'agent_complete', {
          runId,
          content: response.content,
          toolCalls: [],
          usage: response.usage,
        });
      }
    } catch (error: any) {
      getLogger().error({ error: error.message, runId }, 'Agent request failed');
      this.sendError(ws, req.id, `Agent error: ${error.message}`);
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
    const sessionKey = params.sessionId || `${params.channel}_${params.userId}`;
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = this.sessionStore.getOrCreate(sessionKey);
      this.sessions.set(sessionKey, session);
    }

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ingestParams = { channel: params.channel, userId: params.userId };

    try {
      session.messages.push({ role: 'user', content: params.content });
      await this.ingestMessage(session, session.messages[session.messages.length - 1], ingestParams);

      const systemPrompt = await this.promptBuilder.buildSystemPrompt();

      const { messages: contextMessages, systemPrompt: finalSystem } = await this.prepareContext(session, systemPrompt, params.content);

      const response = await this.llmRouter.call({
        messages: contextMessages,
        system: finalSystem,
        tools: this.tools.map(t => t.tool),
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
          const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
          if (tool) {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await tool.execute(args);
            const toolMsg: Message = { role: 'tool', content: result.output, tool_call_id: toolCall.id };
            session.messages.push(toolMsg);
            await this.ingestMessage(session, toolMsg, ingestParams);
          }
        }

        const { messages: finalContextMessages, systemPrompt: finalSystemAgain } = await this.prepareContext(session, finalSystem);

        const finalResponse = await this.llmRouter.call({
          messages: finalContextMessages,
          system: finalSystemAgain,
        });

        const assistantMsg: Message = { role: 'assistant', content: finalResponse.content };
        session.messages.push(assistantMsg);
        await this.ingestMessage(session, assistantMsg, ingestParams);
        await this.checkAutoSnapshot(session);
        this.sessionStore.save(session);
        return finalResponse.content;
      }

      const assistantMsg: Message = { role: 'assistant', content: response.content };
      session.messages.push(assistantMsg);
      await this.ingestMessage(session, assistantMsg, ingestParams);
      await this.checkAutoSnapshot(session);
      this.sessionStore.save(session);
      return response.content;
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
