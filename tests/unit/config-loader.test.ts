import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';

function buildConfig() {
  return {
    agent: { name: 'Alfred', version: '2.1.0', personality_file: '/workspace/config/SOUL.md' },
    llm: { primary_provider: 'primary', fallback_providers: ['fallback'] },
    providers: {
      primary: {
        type: 'openai-compatible',
        enabled: true,
        model: 'auto',
        config: { api_url: 'https://api.example.com/v1', api_key: 'test-key' },
      },
      fallback: {
        type: 'openai-compatible',
        enabled: true,
        model: 'model-fallback',
        config: { api_url: 'http://localhost:11434/v1', api_key: 'test-key-2' },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        type: 'telegram',
        config: { bot_token: 'test-token' },
        permissions: { allow_from: ['12345'] },
      },
      cli: { enabled: false, type: 'cli', config: {} },
    },
    tools: {
      exec: { enabled: true, config: {} },
      file_ops: { enabled: true, config: {} },
      web: { enabled: true, config: {} },
      job: { enabled: true, config: {} },
      system: { enabled: true, config: {} },
      health: { enabled: false, config: {} },
      memory: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/workspace/db/alfred.db' } },
    logging: { level: 'info', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
  };
}

describe('ConfigLoader', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should load configuration without errors', () => {
    const loader = new ConfigLoader(configPath);
    expect(loader).toBeDefined();
    expect(loader.allConfig.agent.version).toBe('2.1.0');
  });

  test('should have valid provider chain in order', () => {
    const loader = new ConfigLoader(configPath);
    expect(loader.providerChain).toEqual(['primary', 'fallback']);
  });

  test('should list enabled channels only', () => {
    const loader = new ConfigLoader(configPath);
    const names = loader.enabledChannels.map(c => c.name);
    expect(names).toContain('telegram');
    expect(names).not.toContain('cli');
  });

  test('should list enabled tools only', () => {
    const loader = new ConfigLoader(configPath);
    expect(loader.enabledTools).toEqual(expect.arrayContaining(['exec', 'file_ops', 'web', 'job', 'system']));
    expect(loader.enabledTools).not.toContain('health');
  });

  test('should resolve workspace-relative paths against WORKSPACE_ROOT', () => {
    const loader = new ConfigLoader(configPath);
    const dbPath = loader.database.config.path;
    expect(dbPath).toContain('alfred.db');
  });

  test('should reload updated config from disk', async () => {
    const loader = new ConfigLoader(configPath);
    expect(loader.llmConfig.primary_provider).toBe('primary');

    const updated = buildConfig();
    updated.llm.primary_provider = 'fallback';
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8');

    await loader.reload();
    expect(loader.llmConfig.primary_provider).toBe('fallback');
  });

  test('should throw when a referenced provider is missing', () => {
    const bad = buildConfig();
    bad.llm.fallback_providers = ['does_not_exist'];
    fs.writeFileSync(configPath, JSON.stringify(bad, null, 2), 'utf-8');

    expect(() => new ConfigLoader(configPath)).toThrow();
  });

  test('should throw on invalid schema', () => {
    const bad = buildConfig();
    (bad.security.gateway_auth_token as any) = 'short';
    fs.writeFileSync(configPath, JSON.stringify(bad, null, 2), 'utf-8');

    expect(() => new ConfigLoader(configPath)).toThrow();
  });
});
