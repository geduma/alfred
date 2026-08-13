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
    llm: { primary_provider: 'primary', fallback_providers: [], retry: { max_attempts: 3, base_delay_ms: 0, max_delay_ms: 0, backoff_factor: 2 } },
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
    expect(breaker.getState('primary').open).toBe(false);
    expect(fakeProvider.call).toHaveBeenCalledTimes(6);
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
    expect(breaker.getState('primary').open).toBe(true);

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('Circuit breaker open');
    expect(fakeProvider.call).toHaveBeenCalledTimes(9);
  });

  test('should retry transient failures and succeed on a later attempt', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn()
        .mockRejectedValueOnce(new Error('Provider error: (status 503)'))
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({ content: 'ok', stop_reason: 'end_turn' }),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    const response = await router.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(fakeProvider.call).toHaveBeenCalledTimes(3);

    const breaker = (router as any).circuitBreaker;
    expect(breaker.getState('primary').open).toBe(false);
  });

  test('should not retry non-retryable client errors', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn().mockRejectedValue(new Error('400 Bad Request')),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');
    expect(fakeProvider.call).toHaveBeenCalledTimes(1);
  });

  test('should respect configured retry max_attempts', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn().mockRejectedValue(new Error('Provider error: (status 503)')),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const cfg = buildConfig();
    cfg.llm.retry = { max_attempts: 2, base_delay_ms: 0, max_delay_ms: 0, backoff_factor: 2 };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('All providers failed');
    expect(fakeProvider.call).toHaveBeenCalledTimes(2);
  });

  test('should fall back to the next provider after exhausting retries', async () => {
    const primary = {
      validateConfig: async () => true,
      call: jest.fn().mockRejectedValue(new Error('Provider error: (status 503)')),
    };
    const fallback = {
      validateConfig: async () => true,
      call: jest.fn().mockResolvedValue({ content: 'from fallback', stop_reason: 'end_turn' }),
    };
    createProvider.mockImplementation(async (config: any) => {
      return config.model === 'auto' ? primary : fallback;
    });

    const cfg = buildConfig();
    cfg.llm.fallback_providers = ['fallback'];
    cfg.llm.retry = { max_attempts: 2, base_delay_ms: 0, max_delay_ms: 0, backoff_factor: 2 };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    const response = await router.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('from fallback');
    expect(primary.call).toHaveBeenCalledTimes(2);
    expect(fallback.call).toHaveBeenCalledTimes(1);
  });

  test('should NOT retry or fail over once content has been delivered mid-stream', async () => {
    const primary = {
      validateConfig: async () => true,
      call: jest.fn().mockImplementation(async (params: any) => {
        params.onEvent?.({ type: 'text_delta', text: 'partial ' });
        throw new Error('stream interrupted after content');
      }),
    };
    const fallback = {
      validateConfig: async () => true,
      call: jest.fn().mockResolvedValue({ content: 'fallback', stop_reason: 'end_turn' }),
    };
    createProvider.mockImplementation(async (config: any) => {
      return config.model === 'auto' ? primary : fallback;
    });

    const cfg = buildConfig();
    cfg.llm.fallback_providers = ['fallback'];
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'LLM_STREAM_INTERRUPTED' });
    expect(primary.call).toHaveBeenCalledTimes(1);
    expect(fallback.call).not.toHaveBeenCalled();
  });

  test('should still retry before any content has been delivered', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockImplementationOnce(async (params: any) => {
          params.onEvent?.({ type: 'text_delta', text: 'ok' });
          return { content: 'ok', stop_reason: 'end_turn' };
        }),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    const response = await router.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(fakeProvider.call).toHaveBeenCalledTimes(2);
  });

  test('should retry when the initial timeout fires before any content', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn()
        .mockRejectedValueOnce({ code: 'LLM_STREAM_TIMEOUT', kind: 'initial', message: 'Request timed out waiting for the first response from the provider after 120s.' })
        .mockResolvedValueOnce({ content: 'ok', stop_reason: 'end_turn' }),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    const response = await router.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(fakeProvider.call).toHaveBeenCalledTimes(2);
  });

  test('should NOT retry when a timeout fires after content was delivered', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn().mockImplementation(async (params: any) => {
        params.onEvent?.({ type: 'text_delta', text: 'partial ' });
        throw { code: 'LLM_STREAM_TIMEOUT', kind: 'idle', message: 'Request timed out: no data received from the provider for 60s.' };
      }),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'LLM_STREAM_INTERRUPTED' });
    expect(fakeProvider.call).toHaveBeenCalledTimes(1);
  });

  test('should pass the centralized streaming config to every provider', async () => {
    const fakeProvider = {
      validateConfig: async () => true,
      call: jest.fn().mockResolvedValue({ content: 'ok', stop_reason: 'end_turn' }),
    };
    createProvider.mockResolvedValue(fakeProvider);

    const cfg = buildConfig();
    (cfg as any).llm.streaming = {
      initial_response_timeout_seconds: 240,
      idle_timeout_seconds: 90,
      max_total_time_seconds: 900,
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const { LLMRouter } = require('../../src/agent/llm-router');
    const router = new LLMRouter(config);
    await router.initialize();

    await router.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'auto' }),
      { initial_response_timeout_seconds: 240, idle_timeout_seconds: 90, max_total_time_seconds: 900 }
    );
  });

  describe('per-provider tool support', () => {
    test('should omit tools when provider has supports_tools=false and no tool artifacts in payload', async () => {
      const fakeProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'ok', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(fakeProvider);

      const cfg = buildConfig();
      (cfg.providers.primary as any).capabilities = { supports_tools: false };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      const response = await router.call({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'exec', description: 'x', inputSchema: {} }] });
      expect(response.content).toBe('ok');
      expect(fakeProvider.call).toHaveBeenCalledTimes(1);
      expect((fakeProvider.call.mock.calls[0][0] as any).tools).toBeUndefined();
    });

    test('should pass tools through when provider supports tools', async () => {
      const fakeProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'ok', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(fakeProvider);

      const cfg = buildConfig();
      (cfg.providers.primary as any).capabilities = { supports_tools: true };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      const tools = [{ name: 'exec', description: 'x', inputSchema: {} }];
      await router.call({ messages: [{ role: 'user', content: 'hi' }], tools });
      expect(fakeProvider.call).toHaveBeenCalledTimes(1);
      expect((fakeProvider.call.mock.calls[0][0] as any).tools).toEqual(tools);
    });

    test('should skip provider that lacks tool support when payload contains tool artifacts', async () => {
      const noToolsProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'should not be called', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(noToolsProvider);

      const cfg = buildConfig();
      (cfg.providers.primary as any).capabilities = { supports_tools: false };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      const messages = [
        { role: 'user' as const, content: 'hi' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'exec', arguments: '{}' } }],
        },
        { role: 'tool' as const, tool_call_id: 'call_1', content: 'done' },
      ];

      await expect(router.call({ messages })).rejects.toThrow('All providers failed');
      expect(noToolsProvider.call).not.toHaveBeenCalled();
    });

    test('should fail over to a tools-capable provider, skipping the no-tools fallback when history has tool_calls', async () => {
      const primary = {
        validateConfig: async () => true,
        call: jest.fn().mockRejectedValue(new Error('Provider error: (status 503)')),
      };
      const noToolsFallback = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'fallback should not be called', stop_reason: 'end_turn' }),
      };
      createProvider.mockImplementation(async (config: any) => {
        return config.model === 'auto' ? primary : noToolsFallback;
      });

      const cfg = buildConfig();
      cfg.llm.fallback_providers = ['fallback'];
      cfg.llm.retry = { max_attempts: 2, base_delay_ms: 0, max_delay_ms: 0, backoff_factor: 2 };
      (cfg.providers.fallback as any).capabilities = { supports_tools: false };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      const messages = [
        { role: 'user' as const, content: 'hi' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'exec', arguments: '{}' } }],
        },
        { role: 'tool' as const, tool_call_id: 'call_1', content: 'done' },
      ];

      await expect(router.call({ messages })).rejects.toThrow(/tool artifacts/i);
      expect(noToolsFallback.call).not.toHaveBeenCalled();
    });

    test('should strip tool artifacts when called with an empty tools array (413 fallback)', async () => {
      const fakeProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'ok', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(fakeProvider);

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      const messages = [
        { role: 'user' as const, content: 'hi' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'exec', arguments: '{}' } }],
        },
        { role: 'tool' as const, tool_call_id: 'call_1', content: 'done' },
        { role: 'user' as const, content: 'continue' },
      ];

      const response = await router.call({ messages, tools: [] });
      expect(response.content).toBe('ok');
      expect(fakeProvider.call).toHaveBeenCalledTimes(1);

      const sent = (fakeProvider.call.mock.calls[0][0] as any).messages;
      expect(sent.some((m: any) => m.role === 'tool')).toBe(false);
      expect(sent.some((m: any) => m.tool_calls && m.tool_calls.length > 0)).toBe(false);
      expect(sent).toHaveLength(3);

      expect(messages.some((m: any) => m.role === 'tool')).toBe(true);
    });

    test('should keep supports_tools=false skip behavior when tools are not provided at all', async () => {
      const noToolsProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'should not be called', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(noToolsProvider);

      const cfg = buildConfig();
      (cfg.providers.primary as any).capabilities = { supports_tools: false };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      const messages = [
        { role: 'user' as const, content: 'hi' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'exec', arguments: '{}' } }],
        },
        { role: 'tool' as const, tool_call_id: 'call_1', content: 'done' },
      ];

      await expect(router.call({ messages })).rejects.toThrow('All providers failed');
      expect(noToolsProvider.call).not.toHaveBeenCalled();
    });
  });

  describe('token budget gating', () => {
    const blockedBudget = {
      allowed: false,
      reason: 'daily_limit',
      remainingPercent: 0,
      dailyRemainingPercent: 0,
      monthlyRemainingPercent: 50,
    };
    const allowedBudget = {
      allowed: true,
      remainingPercent: 100,
      dailyRemainingPercent: 100,
      monthlyRemainingPercent: 100,
    };

    test('should throw BudgetBlockedError when block_all and budget exceeded', async () => {
      const fakeProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'ok', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(fakeProvider);

      const cfg = buildConfig();
      (cfg as any).llm.spending_limits = { enabled: true, daily_token_limit: 1000, monthly_token_limit: 100000, warn_threshold: 0.8, on_limit_reached: 'block_all' };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      jest.spyOn(router.getBudgetTracker(), 'checkBudget').mockResolvedValue(blockedBudget as any);

      await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'BUDGET_BLOCKED' });
      expect(fakeProvider.call).not.toHaveBeenCalled();
    });

    test('should skip paid providers when budget exceeded and block_paid_providers', async () => {
      const paidProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'paid', stop_reason: 'end_turn' }),
      };
      const freeProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'free', stop_reason: 'end_turn' }),
      };
      createProvider.mockImplementation(async (config: any) => {
        return config.model === 'auto' ? paidProvider : freeProvider;
      });

      const cfg = buildConfig();
      cfg.providers.primary.type = 'anthropic';
      cfg.llm.fallback_providers = ['fallback'];
      (cfg as any).llm.spending_limits = { enabled: true, daily_token_limit: 1000, monthly_token_limit: 100000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      jest.spyOn(router.getBudgetTracker(), 'checkBudget').mockResolvedValue(blockedBudget as any);

      const response = await router.call({ messages: [{ role: 'user', content: 'hi' }] });
      expect(response.content).toBe('free');
      expect(paidProvider.call).not.toHaveBeenCalled();
      expect(freeProvider.call).toHaveBeenCalledTimes(1);
    });

    test('should use paid providers when budget is within limits', async () => {
      const paidProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'paid', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(paidProvider);

      const cfg = buildConfig();
      cfg.providers.primary.type = 'anthropic';
      (cfg as any).llm.spending_limits = { enabled: true, daily_token_limit: 1000, monthly_token_limit: 100000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      jest.spyOn(router.getBudgetTracker(), 'checkBudget').mockResolvedValue(allowedBudget as any);

      const response = await router.call({ messages: [{ role: 'user', content: 'hi' }] });
      expect(response.content).toBe('paid');
      expect(paidProvider.call).toHaveBeenCalledTimes(1);
    });

    test('should throw BudgetBlockedError when budget exceeded and only paid providers exist', async () => {
      const paidProvider = {
        validateConfig: async () => true,
        call: jest.fn().mockResolvedValue({ content: 'paid', stop_reason: 'end_turn' }),
      };
      createProvider.mockResolvedValue(paidProvider);

      const cfg = buildConfig();
      cfg.providers.primary.type = 'anthropic';
      (cfg as any).llm.spending_limits = { enabled: true, daily_token_limit: 1000, monthly_token_limit: 100000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

      const config = new ConfigLoader(configPath);
      const { LLMRouter } = require('../../src/agent/llm-router');
      const router = new LLMRouter(config);
      await router.initialize();

      jest.spyOn(router.getBudgetTracker(), 'checkBudget').mockResolvedValue(blockedBudget as any);

      await expect(router.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'BUDGET_BLOCKED' });
      expect(paidProvider.call).not.toHaveBeenCalled();
    });
  });
});
