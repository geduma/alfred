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

  test('should accept optional agent.trace and max_tool_iterations', () => {
    const cfg = buildConfig();
    cfg.agent.trace = true;
    cfg.agent.max_tool_iterations = 12;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const loader = new ConfigLoader(configPath);
    expect(loader.allConfig.agent.trace).toBe(true);
    expect(loader.allConfig.agent.max_tool_iterations).toBe(12);
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

  test('should load optional voice config with per-direction providers', () => {
    const cfg = buildConfig();
    (cfg as any).voice = {
      enabled: true,
      timeout_seconds: 60,
      provider: { api_url: 'http://speaches.home/v1', api_key: '' },
      stt: {
        provider: { api_url: 'https://api.groq.com/openai/v1', api_key: 'groq-key' },
        model: 'whisper-large-v3-turbo',
        language: 'auto',
      },
      tts: {
        model: 'speaches-ai/piper-es_MX-ald-medium',
        voice: 'ald',
        response_format: 'wav',
        expose_to_model: true,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const loader = new ConfigLoader(configPath);
    expect(loader.voiceConfig).toBeDefined();
    expect(loader.voiceConfig?.enabled).toBe(true);
    expect(loader.voiceConfig?.stt?.provider?.api_url).toBe('https://api.groq.com/openai/v1');
    expect(loader.voiceConfig?.tts?.expose_to_model).toBe(true);
  });

  test('should default voice to disabled when absent', () => {
    const loader = new ConfigLoader(configPath);
    expect(loader.voiceConfig).toBeUndefined();
  });

  test('should apply default streaming timeouts when llm.streaming is absent', () => {
    const loader = new ConfigLoader(configPath);
    expect(loader.llmConfig.streaming).toEqual({
      initial_response_timeout_seconds: 120,
      idle_timeout_seconds: 60,
      max_total_time_seconds: null,
    });
  });

  test('should accept a centralized llm.streaming configuration', () => {
    const cfg = buildConfig();
    (cfg as any).llm.streaming = {
      initial_response_timeout_seconds: 240,
      idle_timeout_seconds: 90,
      max_total_time_seconds: 900,
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const loader = new ConfigLoader(configPath);
    expect(loader.llmConfig.streaming).toEqual({
      initial_response_timeout_seconds: 240,
      idle_timeout_seconds: 90,
      max_total_time_seconds: 900,
    });
  });

  test('should merge partial llm.streaming with defaults', () => {
    const cfg = buildConfig();
    (cfg as any).llm.streaming = { initial_response_timeout_seconds: 300 };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const loader = new ConfigLoader(configPath);
    expect(loader.llmConfig.streaming).toEqual({
      initial_response_timeout_seconds: 300,
      idle_timeout_seconds: 60,
      max_total_time_seconds: null,
    });
  });

  test('should reject invalid llm.streaming values', () => {
    const cfg = buildConfig();
    (cfg as any).llm.streaming = { initial_response_timeout_seconds: -5 };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    expect(() => new ConfigLoader(configPath)).toThrow();
  });

  test('should ignore legacy per-provider streaming timeout fields', () => {
    const cfg = buildConfig();
    (cfg.providers.primary.config as any).stream_idle_timeout_seconds = 10;
    (cfg.providers.primary.config as any).max_total_time_seconds = 20;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const loader = new ConfigLoader(configPath);
    const provider = loader.providers.primary;
    expect((provider.config as any).stream_idle_timeout_seconds).toBeUndefined();
    expect((provider.config as any).max_total_time_seconds).toBeUndefined();
  });
});
