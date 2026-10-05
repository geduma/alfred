import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';
import { Conductor } from '../../src/agent/conductor';

const ECO = {
  executor_poll_interval_ms: 50,
  conductor_poll_interval_ms: 50,
  sync_fast_path_timeout_ms: 8000,
  max_task_attempts: 2,
  orphan_reap_on_startup: true,
};

describe('Conductor session queue', () => {
  let testDir: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
    tasks = new TaskRepository();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('countPendingBySession tracks pending and running per session', async () => {
    await tasks.create({ origin_channel: 'cli', session_id: 's1', kind: 'user_request', input: 'q1' });
    await tasks.create({ origin_channel: 'cli', session_id: 's1', kind: 'user_request', input: 'q2' });
    await tasks.create({ origin_channel: 'cli', session_id: 's2', kind: 'user_request', input: 'q3' });

    expect(await tasks.countPendingBySession('s1')).toBe(2);
    expect(await tasks.countPendingBySession('s2')).toBe(1);
    expect(await tasks.countPendingBySession('s3')).toBe(0);

    tasks.claimNext();
    expect(await tasks.countPendingBySession('s1')).toBe(2);
  });

  test('new message with a pending task enqueues with position and skips the probe', async () => {
    const tryFastPath = jest.fn();
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null), tryFastPath };
    const conductor = new Conductor({
      gateway,
      tasks,
      channelManager: { sendMessage: jest.fn() } as any,
      getEcosystem: () => ECO,
    });

    await tasks.create({
      origin_channel: 'telegram',
      origin_chat_id: 'chat-9',
      session_id: 'telegram_u9',
      kind: 'user_request',
      input: 'long task',
    });

    const reply = await conductor.handleMessage({
      channel: 'telegram',
      userId: 'u9',
      content: 'another question',
      sessionId: 'telegram_u9',
      metadata: { chat_id: 'chat-9' },
    });

    expect(tryFastPath).not.toHaveBeenCalled();
    expect(reply).toMatch(/1.*queue|1.*cola/i);
    expect(await tasks.countPendingBySession('telegram_u9')).toBe(2);
    expect(await tasks.countByStatus('pending')).toBe(2);
  });

  test('first message still goes through the fast path', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      tryFastPath: jest.fn().mockResolvedValue({ completed: true, text: 'hi' }),
    };
    const conductor = new Conductor({
      gateway,
      tasks,
      channelManager: { sendMessage: jest.fn() } as any,
      getEcosystem: () => ECO,
    });

    const reply = await conductor.handleMessage({
      channel: 'cli',
      userId: 'u1',
      content: 'hello',
      sessionId: 's1',
    });

    expect(gateway.tryFastPath).toHaveBeenCalledTimes(1);
    expect(reply).toBe('hi');
    expect(await tasks.countByStatus('pending')).toBe(0);
  });

  test('rate-limited message is denied without creating a task or probing', async () => {
    const tryFastPath = jest.fn();
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue('Rate limit exceeded. Please wait.'),
      tryFastPath,
    };
    const conductor = new Conductor({
      gateway,
      tasks,
      channelManager: { sendMessage: jest.fn() } as any,
      getEcosystem: () => ECO,
    });

    const reply = await conductor.handleMessage({
      channel: 'telegram',
      userId: 'u9',
      content: 'spam while busy',
      sessionId: 'telegram_u9',
      metadata: { chat_id: 'chat-9' },
    });

    expect(reply).toBe('Rate limit exceeded. Please wait.');
    expect(tryFastPath).not.toHaveBeenCalled();
    expect(await tasks.countByStatus('pending')).toBe(0);
  });
});
