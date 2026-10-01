import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';

const VALID_TOKEN = 'a'.repeat(64);

function buildConfig(overrides: any = {}) {
  return {
    agent: { name: 'Alfred', version: '2.2.0', personality_file: '/workspace/config/SOUL.md' },
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
      exec: { enabled: false, config: {} },
      file_ops: { enabled: false, config: {} },
      web: { enabled: false, config: {} },
      job: { enabled: false, config: {} },
      system: { enabled: false, config: {} },
      health: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/tmp/ws-auth-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: { gateway_auth_token: 'test-auth-token-12345678' },
    server: { port: 18789, host: '127.0.0.1', web_auth_token: VALID_TOKEN },
    ...overrides,
  };
}

function buildGateway(raw: any): Gateway {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-auth-'));
  const configPath = path.join(testDir, 'alfred.json');
  fs.writeFileSync(configPath, JSON.stringify(raw), 'utf-8');
  const config = new ConfigLoader(configPath);
  const gateway = new Gateway(
    config,
    { call: jest.fn() } as any,
    { buildSystemPrompt: jest.fn(), reload: jest.fn() } as any,
    { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() } as any
  );
  (gateway as any).testDir = testDir;
  return gateway;
}

function closeGateway(gateway: Gateway): void {
  (gateway as any).rateLimiter.stop();
  fs.rmSync((gateway as any).testDir, { recursive: true, force: true });
}

describe('checkWebUpgrade matrix', () => {
  test('should accept a valid token from an allowed IP', () => {
    const gateway = buildGateway(buildConfig());
    try {
      expect(gateway.checkWebUpgrade(`/ws?token=${VALID_TOKEN}`, '127.0.0.1')).toEqual({
        allowed: true,
        isWeb: true,
      });
    } finally {
      closeGateway(gateway);
    }
  });

  test('should reject a missing token without exposing anything', () => {
    const gateway = buildGateway(buildConfig());
    try {
      const decision = gateway.checkWebUpgrade('/ws', '127.0.0.1');
      expect(decision).toEqual({ allowed: false, isWeb: true, reason: 'missing_token' });
    } finally {
      closeGateway(gateway);
    }
  });

  test('should reject an invalid token', () => {
    const gateway = buildGateway(buildConfig());
    try {
      const decision = gateway.checkWebUpgrade('/ws?token=wrong', '127.0.0.1');
      expect(decision).toEqual({ allowed: false, isWeb: true, reason: 'invalid_token' });
    } finally {
      closeGateway(gateway);
    }
  });

  test('should fail closed when the token is CHANGE_ME or absent', () => {
    for (const server of [{ web_auth_token: 'CHANGE_ME' }, {}]) {
      const gateway = buildGateway(buildConfig({ server: { port: 18789, host: '127.0.0.1', ...server } }));
      try {
        expect(gateway.checkWebUpgrade(`/ws?token=${VALID_TOKEN}`, '127.0.0.1')).toEqual({
          allowed: false,
          isWeb: true,
          reason: 'token_not_configured',
        });
      } finally {
        closeGateway(gateway);
      }
    }
  });

  test('should reject a valid token from an IP outside the allowlist', () => {
    const gateway = buildGateway(
      buildConfig({
        channels: {
          cli: { enabled: true, type: 'cli', config: {} },
          web: { enabled: true, type: 'web', config: {}, permissions: { allow_from: ['10.99.99.0/24'] } },
        },
      })
    );
    try {
      expect(gateway.checkWebUpgrade(`/ws?token=${VALID_TOKEN}`, '192.168.1.50')).toEqual({
        allowed: false,
        isWeb: true,
        reason: 'ip_denied',
      });
      expect(gateway.checkWebUpgrade(`/ws?token=${VALID_TOKEN}`, '10.99.99.7')).toEqual({
        allowed: true,
        isWeb: true,
      });
    } finally {
      closeGateway(gateway);
    }
  });

  test('should leave the main gateway path on its own auth', () => {
    const gateway = buildGateway(buildConfig());
    try {
      expect(gateway.checkWebUpgrade('/', '127.0.0.1')).toEqual({ allowed: true, isWeb: false });
    } finally {
      closeGateway(gateway);
    }
  });
});
