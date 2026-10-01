import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/db';

function buildConfig(dbPath: string) {
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
    database: { type: 'sqlite', config: { path: dbPath } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: { gateway_auth_token: 'test-auth-token-12345678' },
    ecosystem: {
      executor_poll_interval_ms: 50,
      conductor_poll_interval_ms: 50,
      sync_fast_path_timeout_ms: 8000,
      max_task_attempts: 2,
      orphan_reap_on_startup: true,
    },
  };
}

describe('agent-mode jobs enqueue into tasks', () => {
  let testDir: string;
  let gateway: Gateway;
  let sendMessage: jest.Mock;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jobs-'));
    const dbPath = path.join(testDir, 'test.db');
    await initializeDatabase(dbPath);
    const configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(dbPath)), 'utf-8');
    const config = new ConfigLoader(configPath);
    sendMessage = jest.fn();
    gateway = new Gateway(
      config,
      {} as any,
      { buildSystemPrompt: jest.fn(), reload: jest.fn() } as any,
      { startAll: jest.fn(), stopAll: jest.fn(), sendMessage } as any
    );
  });

  afterEach(async () => {
    (gateway as any).rateLimiter.stop();
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should enqueue a scheduled_job task instead of answering directly', async () => {
    const processSpy = jest.spyOn(gateway as any, 'processMessage');
    await (gateway as any).handleAgentJobFire({
      id: 'job-1',
      message: 'Run the Daily Digest skill',
      created_at: new Date().toISOString(),
      created_by: { channel: 'telegram', user_id: 'user-1', chat_id: 'chat-1' },
      notification_channels: null,
      schedule: { type: 'daily' },
      next_fire: null,
      last_fired: null,
      enabled: true,
      mode: 'agent',
    });

    expect(processSpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const rows = getDatabase().prepare('SELECT * FROM tasks').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin_channel: 'telegram',
      origin_chat_id: 'chat-1',
      session_id: 'telegram_user-1_jobs',
      kind: 'scheduled_job',
      input: 'Run the Daily Digest skill',
      status: 'pending',
    });
  });
});
