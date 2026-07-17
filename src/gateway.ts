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

    getLogger().info({ port: this.port }, 'Gateway WebSocket server started');

    await this.channelManager.startAll();
  }

  async stop(): Promise<void> {
    this.stopJobRunner();
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

  private async prepareContext(session: StoredSession, systemPrompt: string): Promise<Message[]> {
    const systemPromptTokens = approximateSystemPromptTokens(systemPrompt);

    if (this.contextCompressor.shouldCompact(session.messages, systemPromptTokens)) {
      const result = await this.contextCompressor.compactSession(
        session.summary,
        session.messages,
        systemPromptTokens
      );

      if (result.wasCompacted) {
        session.summary = result.summary;
        return result.messages;
      }
    }

    return session.messages;
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

    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt();

      session.messages.push({ role: 'user', content: message });

      const contextMessages = await this.prepareContext(session, systemPrompt);

      const response = await this.llmRouter.call({
        messages: contextMessages,
        system: systemPrompt,
        tools: this.tools.map(t => t.tool),
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
          const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
          if (tool) {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await tool.execute(args);
            session.messages.push({
              role: 'tool',
              content: result.output,
              tool_call_id: toolCall.id,
            });
          }
        }

        const finalContextMessages = await this.prepareContext(session, systemPrompt);

        const finalResponse = await this.llmRouter.call({
          messages: finalContextMessages,
          system: systemPrompt,
        });

        session.messages.push({ role: 'assistant', content: finalResponse.content });
        this.sessionStore.save(session);

        this.sendEvent(ws, 'agent_complete', {
          runId,
          content: finalResponse.content,
          toolCalls: response.tool_calls,
          usage: finalResponse.usage,
        });
      } else {
        session.messages.push({ role: 'assistant', content: response.content });
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

    try {
      session.messages.push({ role: 'user', content: params.content });

      const systemPrompt = await this.promptBuilder.buildSystemPrompt();

      const contextMessages = await this.prepareContext(session, systemPrompt);

      const response = await this.llmRouter.call({
        messages: contextMessages,
        system: systemPrompt,
        tools: this.tools.map(t => t.tool),
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const toolCall of response.tool_calls) {
          const tool = this.tools.find(t => t.tool.name === toolCall.function.name);
          if (tool) {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await tool.execute(args);
            session.messages.push({
              role: 'tool',
              content: result.output,
              tool_call_id: toolCall.id,
            });
          }
        }

        const finalContextMessages = await this.prepareContext(session, systemPrompt);

        const finalResponse = await this.llmRouter.call({
          messages: finalContextMessages,
          system: systemPrompt,
        });

        session.messages.push({ role: 'assistant', content: finalResponse.content });
        this.sessionStore.save(session);
        return finalResponse.content;
      }

      session.messages.push({ role: 'assistant', content: response.content });
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
