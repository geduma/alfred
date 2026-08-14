import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';

function buildConfig() {
  return {
    agent: { name: 'Alfred', version: '2.2.0', personality_file: '/workspace/config/SOUL.md', max_tool_iterations: 5 },
    llm: {
      primary_provider: 'primary',
      fallback_providers: [],
      spending_limits: { enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_all' },
    },
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
    database: { type: 'sqlite', config: { path: '/tmp/metrics-test/alfred.db' } },
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

describe('Gateway metrics', () => {
  let testDir: string;
  let configPath: string;
  let gateway: Gateway;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const budgetTracker: any = {
      checkBudget: jest.fn().mockResolvedValue({
        allowed: true,
        remainingPercent: 80,
        dailyRemainingPercent: 80,
        monthlyRemainingPercent: 90,
        reason: undefined,
      }),
      getTokenUsage: jest.fn().mockResolvedValue({
        today: 200,
        thisMonth: 1000,
        byProvider: { primary: { tokens: 1000, requests: 3, is_paid: true } },
      }),
    };
    const fakeRouter: any = {
      call: jest.fn(),
      getBudgetTracker: () => budgetTracker,
      getCircuitStates: () => [
        { provider: 'primary', open: false, remainingMs: 0 },
        { provider: 'fallback', open: true, remainingMs: 30000 },
      ],
    };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('metrics should include runtime state and budget fields', async () => {
    const ws = fakeWs();
    await (gateway as any).handleMetrics(ws, { id: 'm1', params: {} });

    const [sent] = ws.send.mock.calls[0];
    const res = JSON.parse(sent);
    expect(res.type).toBe('res');
    expect(res.payload.metrics).toBeDefined();

    const m = res.payload.metrics;
    expect(m.version).toBe('2.2.0');
    expect(m.providers.primary).toBe('primary');
    expect(m.providers.chain).toEqual(['primary', 'fallback']);
    expect(m.providers.states).toHaveLength(2);

    expect(m.budget.enabled).toBe(true);
    expect(m.budget.allowed).toBe(true);
    expect(m.budget.today).toBe(200);
    expect(m.budget.thisMonth).toBe(1000);
    expect(m.budget.byProvider.primary.tokens).toBe(1000);
    expect(m.budget.remainingPercent).toBe(80);

    expect(m.sessions.active).toBe(0);
    expect(typeof m.webClients).toBe('number');
    expect(m.jobs.total).toBe(0);
    expect(m.jobs.enabled).toBe(0);
    expect(typeof m.skills).toBe('number');
    expect(typeof m.tools).toBe('number');
    expect(m.health).toBeDefined();
    expect(m.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  test('metrics should not leak provider secrets', async () => {
    const ws = fakeWs();
    await (gateway as any).handleMetrics(ws, { id: 'm2', params: {} });

    const [sent] = ws.send.mock.calls[0];
    expect(JSON.stringify(sent)).not.toContain('super-secret-key');
  });
});
