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
    llm: { primary_provider: 'primary', fallback_providers: [] },
    providers: {
      primary: {
        type: 'openai-compatible',
        enabled: true,
        model: 'auto',
        config: { api_url: 'https://api.example.com/v1', api_key: 'test-key' },
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

  test('should respond to an unknown tool_call so the assistant message is not left dangling', async () => {
    routerCall
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [{
          id: 'call_ghost',
          type: 'function',
          function: { name: 'nonexistent_tool', arguments: '{}' },
        }],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: 'ok',
        tool_calls: [],
        stop_reason: 'end_turn',
      });

    const session: any = {
      id: 'session-ghost',
      messages: [{ role: 'user', content: 'do something weird' }],
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

    expect(result.content).toBe('ok');
    expect(routerCall).toHaveBeenCalledTimes(2);

    const toolMsg = session.messages.find((m: Message) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).tool_call_id).toBe('call_ghost');
    expect((toolMsg as any).content).toContain('nonexistent_tool');
  });

  test('should repair dangling tool_calls when preparing context', async () => {
    const session: any = {
      id: 'session-repair',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'orphan_1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
        },
        { role: 'user', content: 'and then?' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await (gateway as any).prepareContext(session, 'system prompt');

    const assistantIdx = result.messages.findIndex((m: Message) => m.role === 'assistant' && m.tool_calls);
    expect(assistantIdx).toBeGreaterThan(-1);

    const toolMsg = result.messages[assistantIdx + 1];
    expect(toolMsg.role).toBe('tool');
    expect((toolMsg as any).tool_call_id).toBe('orphan_1');

    expect(session.messages).toContainEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: 'orphan_1' })
    );
  });

  test('should shrink the context budget, compact, and retry on a 413 error', async () => {
    routerCall
      .mockRejectedValueOnce(new Error('API request failed: 413 Request Entity Too Large. Requested 8000 tokens'))
      .mockResolvedValueOnce({
        content: 'adapted',
        tool_calls: [],
        stop_reason: 'end_turn',
      });

    const session: any = {
      id: 'session-413',
      messages: [{ role: 'user', content: 'write a very long story about space exploration and robots' }],
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

    expect(result.content).toBe('adapted');
    expect(routerCall).toHaveBeenCalledTimes(2);

    const learned = (gateway as any).providerContextBudgets.get('primary');
    expect(learned).toBeDefined();
    expect(learned).toBeLessThan(32000);

    const secondCall = routerCall.mock.calls[1][0];
    expect(secondCall.max_tokens).toBeLessThan(4096);
  });

  test('should retry without tools after repeated request-too-large errors', async () => {
    routerCall
      .mockRejectedValueOnce(new Error('413 Request Entity Too Large. Requested 9000 tokens'))
      .mockRejectedValueOnce(new Error('413 Request Entity Too Large. Requested 6000 tokens'))
      .mockRejectedValueOnce(new Error('413 Request Entity Too Large. Requested 4000 tokens'))
      .mockRejectedValueOnce(new Error('413 Request Entity Too Large. Requested 2500 tokens'))
      .mockResolvedValueOnce({
        content: 'survived without tools',
        tool_calls: [],
        stop_reason: 'end_turn',
      });

    const session: any = {
      id: 'session-nolimit',
      messages: [{ role: 'user', content: 'please summarize this giant conversation for me' }],
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

    expect(result.content).toBe('survived without tools');
    expect(routerCall).toHaveBeenCalledTimes(5);

    const noToolsCall = routerCall.mock.calls[4][0];
    expect(noToolsCall.tools).toHaveLength(0);
  });

  test('should propagate a non-throttle error without retrying', async () => {
    routerCall.mockRejectedValue(new Error('Connection refused'));

    const session: any = {
      id: 'session-conn',
      messages: [{ role: 'user', content: 'hello' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(
      (gateway as any).runAgentLoop(
        session,
        'system prompt',
        session.messages,
        { channel: 'cli', userId: 'u', metadata: {} },
        () => {}
      )
    ).rejects.toThrow('Connection refused');

    expect(routerCall).toHaveBeenCalledTimes(1);
  });

  describe('agent-mode job firing', () => {
    let processSpy: jest.SpyInstance;

    const allowBudget = () => {
      (gateway as any).llmRouter.getBudgetTracker = () => ({
        checkBudget: async () => ({ allowed: true, remainingPercent: 100 }),
      });
    };

    const makeJob = (overrides: any = {}) => ({
      id: 'job_digest',
      message: 'Run the Daily Digest skill',
      mode: 'agent' as const,
      created_by: { channel: 'telegram', user_id: 'u1', chat_id: 42 },
      ...overrides,
    });

    beforeEach(() => {
      allowBudget();
      processSpy = jest.spyOn(gateway, 'processMessage').mockResolvedValue('Good morning ☀️');
    });

    afterEach(() => {
      processSpy.mockRestore();
      (gateway as any).lastAgentJobFire.clear();
    });

    test('should route an agent job through processMessage with a dedicated session and send the reply to the channel', async () => {
      await (gateway as any).handleAgentJobFire(makeJob());

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy.mock.calls[0][0]).toEqual(expect.objectContaining({
        channel: 'telegram',
        userId: 'u1',
        content: 'Run the Daily Digest skill',
        sessionId: 'telegram_u1_jobs',
        metadata: { source: 'job', jobId: 'job_digest' },
      }));

      expect((gateway as any).channelManager.sendMessage)
        .toHaveBeenCalledWith('telegram', 'u1', 'Good morning ☀️', { chat_id: 42 });
    });

    test('should skip an agent job when the min interval has not elapsed', async () => {
      (gateway as any).lastAgentJobFire.set('job_digest', Date.now());

      await (gateway as any).handleAgentJobFire(makeJob());

      expect(processSpy).not.toHaveBeenCalled();
      expect((gateway as any).channelManager.sendMessage).toHaveBeenCalled();
      const msg = (gateway as any).channelManager.sendMessage.mock.calls[0];
      expect(msg[0]).toBe('telegram');
      expect(String(msg[2])).toContain('Skipped');
    });

    test('should skip an agent job when the token budget is exhausted', async () => {
      (gateway as any).llmRouter.getBudgetTracker = () => ({
        checkBudget: async () => ({ allowed: false, reason: 'daily_limit', remainingPercent: 0 }),
      });

      await (gateway as any).handleAgentJobFire(makeJob());

      expect(processSpy).not.toHaveBeenCalled();
      expect((gateway as any).channelManager.sendMessage).toHaveBeenCalled();
    });

    test('should record the fire time after a successful pass', async () => {
      await (gateway as any).handleAgentJobFire(makeJob());
      expect((gateway as any).lastAgentJobFire.get('job_digest')).toBeDefined();
    });
  });

  test('should skip rate limiting for job-triggered messages', async () => {
    const checkUser = jest.spyOn((gateway as any).rateLimiter, 'checkUser');
    const checkChannel = jest.spyOn((gateway as any).rateLimiter, 'checkChannel');

    (gateway as any).sessions.set('telegram_u1_jobs', {
      id: 'telegram_u1_jobs',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await (gateway as any).processMessage({
      channel: 'telegram',
      userId: 'u1',
      content: 'Run the System Check skill',
      sessionId: 'telegram_u1_jobs',
      metadata: { source: 'job', jobId: 'job_x' },
    });

    expect(checkUser).not.toHaveBeenCalled();
    expect(checkChannel).not.toHaveBeenCalled();
    expect(typeof result).toBe('string');
  });
});
