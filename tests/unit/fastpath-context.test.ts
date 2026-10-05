import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { ToolHandler } from '../../src/types/tool';

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
    },
    database: { type: 'sqlite', config: { path: '/tmp/fastpath-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
    ecosystem: {
      executor_poll_interval_ms: 50,
      conductor_poll_interval_ms: 50,
      sync_fast_path_timeout_ms: 8000,
      max_task_attempts: 2,
      orphan_reap_on_startup: true,
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

  async execute() {
    return { success: true, output: 'ok', exitCode: 0 };
  }
}

describe('tryFastPath conversational context', () => {
  let testDir: string;
  let gateway: Gateway;
  let routerCall: jest.Mock;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastpath-test-'));
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    routerCall = jest.fn();
    const fakeRouter: any = { call: routerCall };
    const fakePromptBuilder: any = {
      buildSystemPrompt: jest.fn().mockResolvedValue('system prompt'),
      reload: jest.fn(),
    };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    gateway.setTools([new FakeExecTool()]);
  });

  afterEach(async () => {
    await (gateway as any).flushPendingSaves?.().catch(() => {});
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function seedSession(history: Array<{ role: 'user' | 'assistant'; content: string }>): any {
    const session: any = {
      id: 's1',
      messages: [...history],
      summary: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (gateway as any).sessions.set('s1', session);
    return session;
  }

  test('probe sees the current question, not just history', async () => {
    const session = seedSession([
      { role: 'user', content: 'my cert expires soon' },
      { role: 'assistant', content: 'it expires in 12 days' },
    ]);
    routerCall.mockResolvedValue({ content: 'Q2 answer', tool_calls: [], stop_reason: 'end_turn' });

    const result = await gateway.tryFastPath({
      channel: 'cli',
      userId: 'u1',
      content: 'and the backup server?',
      sessionId: 's1',
    });

    expect(result.completed).toBe(true);
    expect(result.text).toBe('Q2 answer');
    const sent = routerCall.mock.calls[0][0].messages;
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'and the backup server?' });
    expect(sent.slice(0, -1)).toEqual([
      { role: 'user', content: 'my cert expires soon' },
      { role: 'assistant', content: 'it expires in 12 days' },
    ]);
    expect(session.messages).toEqual([
      { role: 'user', content: 'my cert expires soon' },
      { role: 'assistant', content: 'it expires in 12 days' },
      { role: 'user', content: 'and the backup server?' },
      { role: 'assistant', content: 'Q2 answer' },
    ]);
  });

  test('probe with tool_calls enqueues instead of persisting a stale answer', async () => {    const session = seedSession([
      { role: 'user', content: 'my cert expires soon' },
      { role: 'assistant', content: 'it expires in 12 days' },
    ]);
    routerCall.mockResolvedValue({
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } }],
      stop_reason: 'tool_use',
    });

    const result = await gateway.tryFastPath({
      channel: 'cli',
      userId: 'u1',
      content: 'check the disk now',
      sessionId: 's1',
    });

    expect(result.completed).toBe(false);
    expect(session.messages).toEqual([
      { role: 'user', content: 'my cert expires soon' },
      { role: 'assistant', content: 'it expires in 12 days' },
    ]);
  });
});

describe('rate-limit pre-check single charge', () => {
  let testDir: string;
  let gateway: Gateway;
  let routerCall: jest.Mock;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratelimit-test-'));
    const configPath = path.join(testDir, 'alfred.json');
    const cfg: any = buildConfig();
    cfg.security.rate_limiting = { enabled: true, requests_per_user_per_hour: 2, requests_per_channel_per_hour: 1000 };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    routerCall = jest.fn().mockResolvedValue({ content: 'ok', tool_calls: [], stop_reason: 'end_turn' });
    const fakeRouter: any = { call: routerCall };
    const fakePromptBuilder: any = {
      buildSystemPrompt: jest.fn().mockResolvedValue('system prompt'),
      reload: jest.fn(),
    };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    gateway.setTools([new FakeExecTool()]);
  });

  afterEach(async () => {
    await (gateway as any).flushPendingSaves?.().catch(() => {});
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('pre-check plus skipped fast-path probe consume one quota unit', async () => {
    expect(gateway.checkRateLimit('cli', 'u1')).toBeNull();

    const result = await gateway.tryFastPath(
      { channel: 'cli', userId: 'u1', content: 'hello', sessionId: 's1' },
      { skipRateLimit: true }
    );
    expect(result.completed).toBe(true);

    expect(gateway.checkRateLimit('cli', 'u1')).toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(gateway.checkRateLimit('cli', 'u1')).toBeNull();
    }
    expect(gateway.checkRateLimit('cli', 'u1')).not.toBeNull();
  });
});
