import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { TokenBudgetTracker } from '../../src/services/token-budget';

function buildConfig(extraLlm: Record<string, unknown> = {}) {
  return {
    agent: {
      name: 'Alfred',
      version: '2.1.0',
      personality_file: '/workspace/config/SOUL.md',
      max_tool_iterations: 5,
    },
    llm: { primary_provider: 'primary', fallback_providers: [], ...extraLlm },
    providers: {
      primary: {
        type: 'openai-compatible',
        enabled: true,
        model: 'auto',
        config: { api_url: 'https://api.example.com/v1', api_key: 'super-secret-key' },
      },
    },
    channels: { cli: { enabled: true, type: 'cli', config: {} } },
    tools: {
      exec: { enabled: true, config: {} },
      file_ops: { enabled: true, config: {} },
      web: { enabled: false, config: {} },
      job: { enabled: false, config: {} },
      system: { enabled: false, config: {} },
      health: { enabled: false, config: {} },
      memory: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/tmp/config-editor-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
  };
}

function fakeWs(): any {
  return { send: jest.fn(), close: jest.fn() };
}

describe('Gateway config editor', () => {
  let testDir: string;
  let configPath: string;
  let gateway: Gateway;
  let routerCall: jest.Mock;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-editor-test-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    routerCall = jest.fn();
    const fakeRouter: any = { call: routerCall };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('config_get should return sanitized config with secrets redacted', async () => {
    const ws = fakeWs();
    await (gateway as any).handleConfigGet(ws, { id: 'c1', params: {} });

    const [sent] = ws.send.mock.calls[0];
    const res = JSON.parse(sent);
    expect(res.type).toBe('res');
    expect(res.payload.config.providers.primary.config.api_key).toBe('*****');
    expect(res.payload.config.security.gateway_auth_token).toBe('*****');
  });

  test('config_update should deep-merge a partial config and persist it', async () => {
    const ws = fakeWs();
    const req = {
      id: 'c2',
      params: {
        config: {
          llm: { retry: { max_attempts: 5, base_delay_ms: 500 } },
          providers: { primary: { model: 'gpt-test' } },
        },
      },
    };

    await (gateway as any).handleConfigUpdate(ws, req);

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.llm.retry.max_attempts).toBe(5);
    expect(raw.llm.retry.base_delay_ms).toBe(500);
    expect(raw.providers.primary.model).toBe('gpt-test');
    expect(raw.providers.primary.config.api_key).toBe('super-secret-key');

    const [sent] = ws.send.mock.calls[0];
    const res = JSON.parse(sent);
    expect(res.type).toBe('res');
    expect(res.payload.status).toBe('saved');
  });

  test('config_update should reject an invalid config', async () => {
    const ws = fakeWs();
    await (gateway as any).handleConfigUpdate(ws, {
      id: 'c3',
      params: { config: { llm: { primary_provider: 12345 } } },
    });

    const [sent] = ws.send.mock.calls[0];
    const res = JSON.parse(sent);
    expect(res.type).toBe('error');
  });

  test('processMessage should return a degraded message without calling the router when budget is blocked', async () => {
    const testDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'config-editor-degraded-'));
    const configPath2 = path.join(testDir2, 'alfred.json');
    fs.writeFileSync(
      configPath2,
      JSON.stringify(buildConfig({
        spending_limits: { enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_all' },
      }), null, 2),
      'utf-8'
    );

    const config = new ConfigLoader(configPath2);
    const tracker = new TokenBudgetTracker(config);
    jest.spyOn(tracker, 'checkBudget').mockResolvedValue({
      allowed: false,
      reason: 'daily_limit',
      remainingPercent: 0,
      dailyRemainingPercent: 0,
      monthlyRemainingPercent: 50,
    });

    const fakeRouter: any = { call: routerCall, getBudgetTracker: () => tracker };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };
    const g = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);

    const response = await g.processMessage({
      channel: 'cli',
      userId: 'user-1',
      content: 'hola',
      sessionId: 'session-1',
    });

    expect(response).toContain('degraded');
    expect(routerCall).not.toHaveBeenCalled();
    fs.rmSync(testDir2, { recursive: true, force: true });
  });
});
