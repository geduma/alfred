import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { ToolHandler } from '../../src/types/tool';
import { Message, ToolCall } from '../../src/types/llm';

function buildConfig() {
  return {
    agent: {
      name: 'Alfred',
      version: '2.1.0',
      personality_file: '/workspace/config/SOUL.md',
      max_tool_iterations: 5,
    },
    llm: { primary_provider: 'relio', fallback_providers: [] },
    providers: {
      relio: {
        type: 'openai-compatible',
        enabled: true,
        model: 'auto',
        config: { api_url: 'http://relio.home/v1', api_key: 'test-key' },
      },
    },
    channels: { cli: { enabled: true, type: 'cli', config: {} } },
    tools: {
      exec: { enabled: true, config: {} },
      file_ops: { enabled: true, config: {} },
      web: { enabled: false, config: {} },
      job: { enabled: false, config: {} },
      system: { enabled: true, config: {} },
      health: { enabled: false, config: {} },
      memory: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/tmp/gateway-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
  };
}

class FakeExecTool implements ToolHandler {
  tool = {
    name: 'exec',
    description: 'Run a command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  };

  async execute(args: Record<string, unknown>) {
    if (args.command === 'ls') {
      return { success: true, output: 'file1.txt\nfile2.txt', exitCode: 0 };
    }
    return { success: false, output: '', error: 'unknown command', exitCode: 1 };
  }
}

describe('Gateway runAgentLoop', () => {
  let testDir: string;
  let configPath: string;
  let gateway: Gateway;
  let routerCall: jest.Mock;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    routerCall = jest.fn();
    const fakeRouter: any = { call: routerCall };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    gateway.setTools([new FakeExecTool()]);
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should persist assistant tool_calls and tool results through the loop', async () => {
    routerCall
      .mockResolvedValueOnce({
        content: 'running command',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'exec', arguments: '{"command":"ls"}' },
        }],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: 'done',
        tool_calls: [],
        stop_reason: 'end_turn',
      });

    const session: any = {
      id: 'session-test',
      messages: [{ role: 'user', content: 'list the files' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await (gateway as any).runAgentLoop(
      session,
      'system prompt',
      session.messages,
      { channel: 'cli', userId: 'test-user', metadata: {} },
      () => {}
    );

    expect(result.content).toBe('done');
    expect(routerCall).toHaveBeenCalledTimes(2);

    const assistantMsg = session.messages.find((m: Message) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg as any).tool_calls).toHaveLength(1);

    const toolMsg = session.messages.find((m: Message) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).tool_call_id).toBe('call_1');
    expect((toolMsg as any).content).toBe('file1.txt\nfile2.txt');
  });

  test('should pass __context to exec tools', async () => {
    routerCall
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'exec', arguments: '{"command":"ls"}' },
        }],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: 'ok',
        tool_calls: [],
        stop_reason: 'end_turn',
      });

    const execTool = new FakeExecTool();
    const spy = jest.spyOn(execTool, 'execute');
    gateway.setTools([execTool]);

    const session: any = {
      id: 'session-context',
      messages: [{ role: 'user', content: 'list files please' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (gateway as any).runAgentLoop(
      session,
      'system prompt',
      session.messages,
      { channel: 'telegram', userId: 'user-9', metadata: { chat_id: 12345 } },
      () => {}
    );

    const execArgs = spy.mock.calls[0][0] as any;
    expect(execArgs.__context).toEqual({ channel: 'telegram', userId: 'user-9', chat_id: 12345 });
  });

  test('should convert invalid tool arguments into a tool error message', async () => {
    routerCall
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{
          id: 'call_bad',
          type: 'function',
          function: { name: 'exec', arguments: 'not-json' },
        }],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: 'recovered',
        tool_calls: [],
        stop_reason: 'end_turn',
      });

    const session: any = {
      id: 'session-bad',
      messages: [{ role: 'user', content: 'run something' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await (gateway as any).runAgentLoop(
      session,
      'system prompt',
      session.messages,
      { channel: 'cli', userId: 'u', metadata: {} },
      () => {}
    );

    expect(result.content).toBe('recovered');
    const errorMsg = session.messages.find((m: Message) => m.role === 'tool');
    expect(errorMsg).toBeDefined();
    expect((errorMsg as any).content).toContain('Invalid JSON');
  });
});
