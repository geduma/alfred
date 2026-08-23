import { safeTokenCompare } from '../../src/utils/secure-compare';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('safeTokenCompare', () => {
  test('accepts identical tokens', () => {
    expect(safeTokenCompare('rpi-alfred-abcdef1234567890', 'rpi-alfred-abcdef1234567890')).toBe(true);
  });

  test('rejects different tokens of equal length', () => {
    expect(safeTokenCompare('rpi-alfred-abcdef1234567890', 'rpi-alfred-abcdef1234567891')).toBe(false);
  });

  test('rejects tokens of different lengths without throwing', () => {
    expect(safeTokenCompare('short', 'a-much-longer-target-token-value')).toBe(false);
    expect(safeTokenCompare('a-much-longer-candidate-token', 'tiny')).toBe(false);
  });

  test('rejects missing or non-string input', () => {
    const token = 'valid-token-value-1234';
    expect(safeTokenCompare(undefined, token)).toBe(false);
    expect(safeTokenCompare(null, token)).toBe(false);
    expect(safeTokenCompare('', token)).toBe(false);
    expect(safeTokenCompare(123 as any, token)).toBe(false);
    expect(safeTokenCompare(token, undefined as any)).toBe(false);
  });
});

describe('Gateway handleConnect token validation', () => {
  let testDir: string;
  let gateway: Gateway;

  const TOKEN = 'test-auth-token-12345678';

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-connect-'));
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(TOKEN), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn() };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };
    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function buildConfig(token: string) {
    return {
      agent: { name: 'Alfred', version: '2.1.0', personality_file: '/workspace/config/SOUL.md' },
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
      tools: {},
      database: { type: 'sqlite', config: { path: '/tmp/gateway-connect-test/alfred.db' } },
      logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
      security: { gateway_auth_token: token },
    };
  }

  function makeSocket() {
    return {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    } as any;
  }

  function lastMessage(socket: { send: jest.Mock }): any {
    return JSON.parse(socket.send.mock.calls.at(-1)[0]);
  }

  test('valid token is accepted and session bound', () => {
    const ws = makeSocket();
    (gateway as any).handleConnect(ws, {
      type: 'req', id: 'r1', method: 'connect',
      params: { auth: { token: TOKEN, sessionId: 'sess-42' } },
    });
    expect(ws.close).not.toHaveBeenCalled();
    expect(lastMessage(ws).payload.status).toBe('connected');
    expect((gateway as any).wsSessions.get(ws)).toBe('sess-42');
  });

  test('wrong token is rejected and socket closed', () => {
    const ws = makeSocket();
    (gateway as any).handleConnect(ws, {
      type: 'req', id: 'r2', method: 'connect',
      params: { auth: { token: 'wrong-token-aaaaaaaaaa' } },
    });
    expect(ws.close).toHaveBeenCalled();
    expect(lastMessage(ws).type).toBe('error');
    expect(lastMessage(ws).message).toContain('Invalid auth token');
  });

  test('missing auth block is rejected', () => {
    const ws = makeSocket();
    (gateway as any).handleConnect(ws, { type: 'req', id: 'r3', method: 'connect', params: {} });
    expect(ws.close).toHaveBeenCalled();
    expect(lastMessage(ws).type).toBe('error');
  });
});
