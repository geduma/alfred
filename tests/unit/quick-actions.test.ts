import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { WebSocket } from 'ws';

function buildConfig() {
  return {
    agent: { name: 'Alfred', version: '2.2.0', personality_file: '/workspace/config/SOUL.md', max_tool_iterations: 5 },
    llm: { primary_provider: 'primary', fallback_providers: [] },
    providers: {
      primary: { type: 'openai-compatible', enabled: true, model: 'auto', config: { api_url: 'https://api.example.com/v1', api_key: 'k' } },
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
    database: { type: 'sqlite', config: { path: '/tmp/qa-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
  };
}

function fakeSocket(): any {
  return { readyState: WebSocket.OPEN, send: jest.fn() };
}

function lastMsg(ws: any): any {
  const calls = ws.send.mock.calls;
  return JSON.parse(calls[calls.length - 1][0]);
}

describe('Gateway quick actions', () => {
  let testDir: string;
  let gateway: Gateway;
  let ws: any;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-qa-'));
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');
    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn(), getBudgetTracker: () => null, getCircuitStates: () => [] };
    const fakePromptBuilder: any = { buildSystemPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };
    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    ws = fakeSocket();
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should list quick actions including doctor', async () => {
    await (gateway as any).onMessage(ws, JSON.stringify({ type: 'req', id: 'q1', method: 'quick_actions_list', params: {} }));
    const msg = lastMsg(ws);
    expect(msg.type).toBe('res');
    expect(msg.payload.actions[0].id).toBe('doctor');
  });

  test('should reject quick_action without action', async () => {
    await (gateway as any).onMessage(ws, JSON.stringify({ type: 'req', id: 'q2', method: 'quick_action', params: {} }));
    expect(lastMsg(ws).type).toBe('error');
  });

  test('should reject unknown quick_action', async () => {
    await (gateway as any).onMessage(ws, JSON.stringify({ type: 'req', id: 'q3', method: 'quick_action', params: { action: 'nope' } }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toMatch(/Unknown quick action/);
  });
});
