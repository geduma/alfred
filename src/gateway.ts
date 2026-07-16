import { WebSocketServer, WebSocket } from 'ws';
import { ConfigLoader } from './config/loader';
import { LLMRouter } from './agent/llm-router';
import { PromptBuilder } from './agent/prompt-builder';
import { ChannelManager } from './channels/channel-manager';
import { getLogger } from './utils/logger';
import { ToolHandler } from './types/tool';
import { Message } from './types/llm';

interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface Session {
  id: string;
  messages: Message[];
  createdAt: Date;
}

export class Gateway {
  private wss: WebSocketServer | null = null;
  private config: ConfigLoader;
  private llmRouter: LLMRouter;
  private promptBuilder: PromptBuilder;
  private channelManager: ChannelManager;
  private tools: ToolHandler[] = [];
  private sessions: Map<string, Session> = new Map();
  private port: number;

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
  }

  setTools(tools: ToolHandler[]): void {
    this.tools = tools;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on('connection', (ws: WebSocket) => this.onClientConnect(ws));

    getLogger().info({ port: this.port }, 'Gateway WebSocket server started');

    await this.channelManager.startAll();
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
    }
    await this.channelManager.stopAll();
    getLogger().info('Gateway stopped');
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
        case 'skill_list':
          this.handleSkillList(ws);
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

    const session = this.getOrCreateSession(sessionId || 'default');
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt();

      session.messages.push({ role: 'user', content: message });

      const response = await this.llmRouter.call({
        messages: session.messages,
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

        const finalResponse = await this.llmRouter.call({
          messages: session.messages,
          system: systemPrompt,
        });

        session.messages.push({ role: 'assistant', content: finalResponse.content });

        this.sendEvent(ws, 'agent_complete', {
          runId,
          content: finalResponse.content,
          toolCalls: response.tool_calls,
          usage: finalResponse.usage,
        });
      } else {
        session.messages.push({ role: 'assistant', content: response.content });

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
    const sessionId = params.sessionId || `${params.channel}_${params.userId}`;
    const session = this.getOrCreateSession(sessionId);
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      session.messages.push({ role: 'user', content: params.content });

      const systemPrompt = await this.promptBuilder.buildSystemPrompt();

      const response = await this.llmRouter.call({
        messages: session.messages,
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

        const finalResponse = await this.llmRouter.call({
          messages: session.messages,
          system: systemPrompt,
        });

        session.messages.push({ role: 'assistant', content: finalResponse.content });
        return finalResponse.content;
      }

      session.messages.push({ role: 'assistant', content: response.content });
      return response.content;
    } catch (error: any) {
      getLogger().error({ error: error.message, runId }, 'Message processing failed');
      return `Lo siento, Señor Felipe. Ocurrió un error: ${error.message}`;
    }
  }

  private handleSkillList(ws: WebSocket): void {
    const skills = this.tools.map(t => ({
      name: t.tool.name,
      description: t.tool.description,
      enabled: true,
    }));

    this.sendResponse(ws, 'skill_list', { skills });
  }

  private getOrCreateSession(sessionId: string): Session {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        messages: [],
        createdAt: new Date(),
      });
    }
    return this.sessions.get(sessionId)!;
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
