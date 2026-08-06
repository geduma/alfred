import fs from 'fs';
import path from 'path';
import os from 'os';

jest.mock('../../src/agent/providers/factory', () => ({
  ProviderFactory: { createProvider: jest.fn() },
}));

import { ConfigLoader } from '../../src/config/loader';

function buildConfig() {
  return {
    agent: { name: 'Alfred', version: '2.1.0', personality_file: '/workspace/config/SOUL.md' },
    llm: { primary_provider: 'relio', fallback_providers: [] },
    providers: {
      relio: {
        type: 'openai-compatible',
        enabled: true,
        model: 'auto',
        config: { api_url: 'http://relio.home/v1', api_key: 'test-key' },
      },
    },
    channels: { cli: { enabled: false, type: 'cli', config: {} } },
    tools: {
      exec: { enabled: true, config: {} },
      file_ops: { enabled: true, config: {} },
      web: { enabled: false, config: {} },
      job: { enabled: false, config: {} },
      system: { enabled: false, config: {} },
      health: { enabled: false, config: {} },
      memory: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/tmp/llm-router-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
  };
}

describe('LLMRouter circuit breaker behavior', () => {
  let testDir: string;
  let configPath: string;
  let createProvider: jest.Mock;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-router-test-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const { ProviderFactory } = require('../../src/agent/providers/factory');
    createProvider = ProviderFactory.createProvider;
    createProvider.mockReset();
  });

  afterEach(() => {
    jest.resetModules();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should NOT open the circuit breaker on throttling errors (413)', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn().mockRejectedValue(new Error('Request too large ... (status 413)')),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');
    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');

    const breaker = (router as any).circuitBreaker;
    expect(breaker.getState('relio').open).toBe(false);
    expect(fakeProvider.call).toHaveBeenCalledTimes(2);
  });

  test('should open the circuit breaker on non-throttling errors', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn().mockRejectedValue(new Error('Provider error: connection refused (status 503)')),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');
    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');
    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');

    const breaker = (router as any).circuitBreaker;
    expect(breaker.getState('relio').open).toBe(true);

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('Circuit breaker open');
    expect(fakeProvider.call).toHaveBeenCalledTimes(3);
  });
});
