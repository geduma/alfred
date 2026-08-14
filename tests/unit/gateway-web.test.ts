import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { WORKSPACE_PATHS } from '../../src/utils/workspace';
import { WebSocket } from 'ws';

function buildConfig() {
  return {
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
    tools: {
      exec: { enabled: true, config: {} },
      file_ops: { enabled: true, config: {} },
      web: { enabled: false, config: {} },
      job: { enabled: false, config: {} },
      system: { enabled: true, config: {} },
      health: { enabled: false, config: {} },
      memory: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/tmp/gateway-web-test/alfred.db' } },
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

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('Gateway web audio', () => {
  let testDir: string;
  let configPath: string;
  let gateway: Gateway;
  let ws: any;
  let runWebAgentMock: jest.Mock;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-web-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn() };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    runWebAgentMock = jest.fn().mockResolvedValue(undefined);
    (gateway as any).runWebAgent = runWebAgentMock;
    ws = fakeSocket();
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const req = (method: string, params: any, id = 'r1') => ({ type: 'req' as const, id, method, params });

  test('should reject audio when voice input is not enabled', async () => {
    await (gateway as any).handleAgentAudio(ws, req('agent_audio', { blob_base64: 'aGVsbG8=', mime: 'audio/webm' }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('Voice input is not enabled on this Alfred instance');
  });

  test('should reject an empty audio blob', async () => {
    (gateway as any).voiceService = { transcribe: jest.fn(), synthesize: jest.fn() };
    await (gateway as any).handleAgentAudio(ws, req('agent_audio', { blob_base64: '', mime: 'audio/webm' }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('Audio blob is required');
    expect((gateway as any).voiceService.transcribe).not.toHaveBeenCalled();
  });

  test('should transcribe audio and forward the transcript to runWebAgent', async () => {
    (gateway as any).voiceService = {
      transcribe: jest.fn().mockResolvedValue({ text: 'hola mundo', language: 'es' }),
      synthesize: jest.fn(),
    };
    await (gateway as any).handleAgentAudio(ws, req('agent_audio', {
      blob_base64: Buffer.from('fake-webm-bytes').toString('base64'),
      mime: 'audio/webm',
      sessionId: 'web-user',
    }));

    const transcript = lastMsg(ws);
    expect(transcript.type).toBe('event');
    expect(transcript.event).toBe('transcript');
    expect(transcript.payload).toEqual({ text: 'hola mundo', language: 'es', final: true });

    expect(runWebAgentMock).toHaveBeenCalledTimes(1);
    expect(runWebAgentMock.mock.calls[0][2]).toEqual({
      text: 'hola mundo',
      sessionId: 'web-user',
      inputType: 'voice',
    });

    const incoming = path.join(WORKSPACE_PATHS.files(), 'audio', 'incoming');
    const files = await fs.promises.readdir(incoming).catch(() => []);
    expect(files.filter((f: string) => f.startsWith('web_'))).toHaveLength(0);
  });

  test('should report a transcription failure', async () => {
    (gateway as any).voiceService = {
      transcribe: jest.fn().mockRejectedValue(new Error('STT unreachable')),
      synthesize: jest.fn(),
    };
    await (gateway as any).handleAgentAudio(ws, req('agent_audio', {
      blob_base64: Buffer.from('bytes').toString('base64'),
      mime: 'audio/webm',
    }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('Transcription failed: STT unreachable');
  });
});

describe('Gateway web file upload', () => {
  let testDir: string;
  let gateway: Gateway;
  let ws: any;
  let runWebAgentMock: jest.Mock;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-file-'));
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn() };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    runWebAgentMock = jest.fn().mockResolvedValue(undefined);
    (gateway as any).runWebAgent = runWebAgentMock;
    ws = fakeSocket();
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const req = (method: string, params: any, id = 'r1') => ({ type: 'req' as const, id, method, params });

  test('should reject a missing file blob', async () => {
    await (gateway as any).handleAgentFile(ws, req('agent_file', { name: 'x.txt', mime: 'text/plain' }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('File blob is required');
  });

  test('should reject a file that is too large', async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 1, 1).toString('base64');
    await (gateway as any).handleAgentFile(ws, req('agent_file', { blob_base64: big, name: 'big.bin', mime: 'application/octet-stream' }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('File is too large');
  });

  test('should emit a no-vision agent_complete for an image when the provider lacks vision', async () => {
    await (gateway as any).handleAgentFile(ws, req('agent_file', {
      blob_base64: TINY_PNG,
      name: 'photo.png',
      mime: 'image/png',
      sessionId: 'web-user',
    }));

    const msg = lastMsg(ws);
    expect(msg.type).toBe('event');
    expect(msg.event).toBe('agent_complete');
    expect(msg.payload.error).toBe(true);
    expect(msg.payload.content).toContain('Image attachments are not supported');
    expect(msg.payload.content).toContain('primary');
    expect(runWebAgentMock).not.toHaveBeenCalled();

    const saved = await fs.promises.readdir(path.join(WORKSPACE_PATHS.files(), 'incoming'));
    expect(saved.some((f: string) => f.endsWith('_photo.png'))).toBe(true);
  });

  test('should forward text file contents to runWebAgent', async () => {
    await (gateway as any).handleAgentFile(ws, req('agent_file', {
      blob_base64: Buffer.from('hello from the file').toString('base64'),
      name: 'notes.txt',
      mime: 'text/plain',
      sessionId: 'web-user',
    }));

    expect(runWebAgentMock).toHaveBeenCalledTimes(1);
    const opts = runWebAgentMock.mock.calls[0][2];
    expect(opts.inputType).toBe('file');
    expect(opts.fileName).toBe('notes.txt');
    expect(opts.text).toContain('[File attachment: notes.txt]');
    expect(opts.text).toContain('hello from the file');
  });

  test('should fall back to a saved-file note for unknown file types', async () => {
    await (gateway as any).handleAgentFile(ws, req('agent_file', {
      blob_base64: Buffer.from('binary-ish').toString('base64'),
      name: 'archive.rar',
      mime: 'application/x-rar-compressed',
      sessionId: 'web-user',
    }));

    expect(runWebAgentMock).toHaveBeenCalledTimes(1);
    const opts = runWebAgentMock.mock.calls[0][2];
    expect(opts.inputType).toBe('file');
    expect(opts.text).toContain('[File attachment: archive.rar]');
    expect(opts.text).toContain('The file has been saved');
  });
});

describe('Gateway preferences', () => {
  let testDir: string;
  let gateway: Gateway;
  let ws: any;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-prefs-'));
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn() };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    ws = fakeSocket();

    fs.mkdirSync(path.dirname(WORKSPACE_PATHS.preferences()), { recursive: true });
    fs.writeFileSync(
      WORKSPACE_PATHS.preferences(),
      '## Dynamic Preferences\nlanguage: spanish\ntone: professional\n',
      'utf-8'
    );
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const req = (method: string, params: any, id = 'r1') => ({ type: 'req' as const, id, method, params });

  test('should read preferences from the preferences file', async () => {
    await (gateway as any).handlePreferences(ws, req('preferences', {}));
    const msg = lastMsg(ws);
    expect(msg.type).toBe('res');
    expect(msg.ok).toBe(true);
    expect(msg.payload.preferences).toEqual({ language: 'spanish', tone: 'professional' });
  });

  test('should update a known preference key in the file', async () => {
    await (gateway as any).handlePreferenceSet(ws, req('preference_set', { key: 'language', value: 'english' }));
    const msg = lastMsg(ws);
    expect(msg.type).toBe('res');
    expect(msg.ok).toBe(true);
    expect(msg.payload).toEqual({ ok: true, key: 'language', value: 'english' });

    await (gateway as any).handlePreferences(ws, req('preferences', {}, 'r2'));
    expect(lastMsg(ws).payload.preferences.language).toBe('english');
    expect(fs.readFileSync(WORKSPACE_PATHS.preferences(), 'utf-8')).toContain('language: english');
  });

  test('should create the file when it does not exist', async () => {
    fs.rmSync(WORKSPACE_PATHS.preferences(), { force: true });
    await (gateway as any).handlePreferenceSet(ws, req('preference_set', { key: 'user_name', value: 'Felipe' }));
    expect(lastMsg(ws).ok).toBe(true);
    const raw = fs.readFileSync(WORKSPACE_PATHS.preferences(), 'utf-8');
    expect(raw).toContain('## Dynamic Preferences');
    expect(raw).toContain('user_name: Felipe');
  });

  test('should reject an unknown preference key', async () => {
    await (gateway as any).handlePreferenceSet(ws, req('preference_set', { key: 'hack_the_planet', value: 'yes' }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('Unknown preference key: hack_the_planet');
    expect(fs.readFileSync(WORKSPACE_PATHS.preferences(), 'utf-8')).not.toContain('hack_the_planet');
  });

  test('should require both key and value', async () => {
    await (gateway as any).handlePreferenceSet(ws, req('preference_set', { key: 'tone' }));
    expect(lastMsg(ws).type).toBe('error');
    expect(lastMsg(ws).message).toBe('Both key and value are required');
  });
});

describe('Gateway web metrics and latency', () => {
  let testDir: string;
  let gateway: Gateway;
  let ws: any;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-metrics-'));
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn() };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    ws = fakeSocket();
  });

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should include the new control-center fields in metrics', async () => {
    await (gateway as any).handleMetrics(ws, { type: 'req', id: 'r1', method: 'metrics', params: {} });
    const m = lastMsg(ws).payload.metrics;

    expect(m.latencyMs).toBeNull();
    expect(m.avgLatencyMs).toBeNull();
    expect(m.activeModel).toBe('primary');
    expect(m.lastQuery).toBeNull();
    expect(m.workspace).toEqual({ filesSizeMb: 0, dbSizeMb: 0, sessionsTotal: 0 });
    expect(m.rag).toEqual({ enabled: false });
    expect(m.snapshots).toEqual({ enabled: false });
    expect(Array.isArray(m.skillNames)).toBe(true);
  });

  test('should track latency and expose the running average', async () => {
    const g = gateway as any;
    g.trackLatency(100);
    g.trackLatency(200);
    g.trackLatency(300);
    expect(g.lastLatencyMs).toBe(300);
    expect(g.avgLatencyMs()).toBe(200);
  });

  test('should bound the latency window', async () => {
    const g = gateway as any;
    for (let i = 0; i < 60; i++) g.trackLatency(1000);
    expect(g.latencies).toHaveLength(50);
  });
});

describe('Gateway web client IP allowlist', () => {
  let testDir: string;
  let gateway: Gateway;

  const buildGateway = async (allowFrom?: string[]) => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-allowlist-'));
    const configPath = path.join(testDir, 'alfred.json');
    const cfg = buildConfig() as any;
    cfg.channels = {
      web: {
        enabled: true,
        type: 'web',
        config: {},
        ...(allowFrom ? { permissions: { allow_from: allowFrom } } : {}),
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

    const config = new ConfigLoader(configPath);
    const fakeRouter: any = { call: jest.fn() };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };
    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
  };

  afterEach(() => {
    (gateway as any).rateLimiter.stop();
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should allow every client when no allow_from is configured', async () => {
    await buildGateway(undefined);
    expect((gateway as any).webIpAllowlist).toBeNull();
    expect((gateway as any).isAllowedWebClient('127.0.0.1')).toBe(true);
    expect((gateway as any).isAllowedWebClient('192.168.1.9')).toBe(true);
    expect((gateway as any).isAllowedWebClient('::1')).toBe(true);
  });

  test('should match exact IPs, CIDRs, and IPv4-mapped forms', async () => {
    await buildGateway(['127.0.0.1', '10.0.0.0/24']);
    const g: any = gateway;

    expect(g.isAllowedWebClient('127.0.0.1')).toBe(true);
    expect(g.isAllowedWebClient('::ffff:127.0.0.1')).toBe(true);
    expect(g.isAllowedWebClient('::1')).toBe(true);
    expect(g.isAllowedWebClient('10.0.0.5')).toBe(true);
    expect(g.isAllowedWebClient('::ffff:10.0.0.5')).toBe(true);

    expect(g.isAllowedWebClient('10.0.1.5')).toBe(false);
    expect(g.isAllowedWebClient('192.168.1.7')).toBe(false);
    expect(g.isAllowedWebClient('2001:db8::1')).toBe(false);
    expect(g.isAllowedWebClient('unknown')).toBe(false);
  });

  test('should ignore invalid allowlist entries without throwing', async () => {
    await buildGateway(['not-an-ip', '10.1.2.0/999', '']);
    const g: any = gateway;
    expect(g.isAllowedWebClient('10.1.2.3')).toBe(false);
    expect(g.isAllowedWebClient('127.0.0.1')).toBe(false);
  });
});
