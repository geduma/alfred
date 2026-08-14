import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';

function buildConfig(overrides: Record<string, unknown> = {}) {
  const base: any = {
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
    tools: { exec: { enabled: true, config: {} } },
    database: { type: 'sqlite', config: { path: '/tmp/gateway-rag-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
      rate_limiting: { enabled: true, requests_per_user_per_hour: 100, requests_per_channel_per_hour: 1000 },
    },
  };
  return { ...base, ...overrides };
}

function makeGateway(configObj: any): Gateway {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-rag-')), 'alfred.json');
  fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2), 'utf-8');
  const config = new ConfigLoader(configPath);
  const fakeRouter: any = { call: jest.fn() };
  const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
  const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };
  const gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
  gateway.setTools([]);
  return gateway;
}

const RAG_RESULT = {
  text: 'memory from another session',
  score: 0.85,
  metadata: {
    sessionId: 'other-session',
    channel: 'cli',
    userId: 'u2',
    timestamp: new Date().toISOString(),
    role: 'user',
    messageId: 'm_other',
  },
};

describe('Gateway RAG and ingest behavior', () => {
  test('should exclude the active session from automatic RAG search', async () => {
    const gateway = makeGateway(buildConfig());
    const searchMock = jest.fn().mockResolvedValue([RAG_RESULT]);
    (gateway as any).vectorStore = { search: searchMock, ingest: jest.fn() };
    (gateway as any).rateLimiter.stop();

    const session: any = {
      id: 'session-me',
      summary: '',
      messages: [{ role: 'user', content: 'hello' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await (gateway as any).prepareContext(session, 'system prompt', 'hello');

    expect(searchMock).toHaveBeenCalledWith('hello', undefined, { excludeSessionId: 'session-me' });
    expect(result.messages[0].content).toContain('RAG CONTEXT');
    expect(result.messages[1]).toEqual(session.messages[0]);
  });

  test('should skip compression when skipCompression is set', async () => {
    const gateway = makeGateway(buildConfig());
    const compressSpy = jest.spyOn((gateway as any).promptCompressor, 'compress');
    (gateway as any).rateLimiter.stop();

    const session: any = {
      id: 'session-skip',
      summary: '',
      messages: [{ role: 'user', content: 'hello' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (gateway as any).prepareContext(session, 'system prompt', undefined, true);
    expect(compressSpy).not.toHaveBeenCalled();

    await (gateway as any).prepareContext(session, 'system prompt');
    expect(compressSpy).toHaveBeenCalledTimes(1);
  });

  test('should respect ingest.on_message = false', async () => {
    const config = buildConfig();
    config.memory = {
      vector_store: {
        enabled: true,
        type: 'lancedb',
        path: '/tmp/vectors',
        embedding: { type: 'hashing', dimension: 256 },
        ingest: { on_message: false, max_chunk_size: 512 },
        search: { top_k: 5, min_score: 0.5 },
      },
    };
    const gateway = makeGateway(config);
    const ingestSpy = jest.fn();
    (gateway as any).vectorStore = { search: jest.fn().mockResolvedValue([]), ingest: ingestSpy };
    (gateway as any).rateLimiter.stop();

    const session: any = {
      id: 'session-ingest',
      summary: '',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (gateway as any).ingestMessage(
      session,
      { role: 'user', content: 'this is a long enough message to index' },
      { channel: 'cli', userId: 'u' }
    );
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  test('should ingest when on_message is enabled (default)', async () => {
    const config = buildConfig();
    config.memory = {
      vector_store: {
        enabled: true,
        type: 'lancedb',
        path: '/tmp/vectors',
        embedding: { type: 'hashing', dimension: 256 },
        ingest: { on_message: true, max_chunk_size: 512 },
        search: { top_k: 5, min_score: 0.5 },
      },
    };
    const gateway = makeGateway(config);
    const ingestSpy = jest.fn().mockResolvedValue(undefined);
    (gateway as any).vectorStore = { search: jest.fn().mockResolvedValue([]), ingest: ingestSpy };
    (gateway as any).rateLimiter.stop();

    const session: any = {
      id: 'session-ingest-2',
      summary: '',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (gateway as any).ingestMessage(
      session,
      { role: 'user', content: 'this is a long enough message to index' },
      { channel: 'cli', userId: 'u' }
    );
    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });
});
