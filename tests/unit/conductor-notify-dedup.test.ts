import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';
import { Conductor } from '../../src/agent/conductor';

jest.mock('../../src/services/preferences-store', () => {
  const actual = jest.requireActual('../../src/services/preferences-store');
  return { ...actual, readPreferences: () => ({ language: 'en' }) };
});

const ECO: any = {
  executor_poll_interval_ms: 50,
  conductor_poll_interval_ms: 20,
  sync_fast_path_timeout_ms: 8000,
  max_task_attempts: 2,
  orphan_reap_on_startup: true,
};

describe('conductor notify dedup', () => {
  let testDir: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-dedup-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
    tasks = new TaskRepository();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('three concurrent polls send once', async () => {
    const gateway: any = { checkRateLimit: jest.fn().mockReturnValue(null) };
    let sends = 0;
    const sendMessage = jest.fn(async () => {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    const conductor = new Conductor({ gateway, tasks, channelManager: { sendMessage } as any, getEcosystem: () => ECO });

    const created = await tasks.create({
      origin_channel: 'telegram',
      origin_chat_id: 'chat-1',
      session_id: 's1',
      kind: 'user_request',
      input: 'hello',
    });
    await tasks.markDone(created.id, 'result text');

    await Promise.all([
      conductor.pollUnnotified(),
      conductor.pollUnnotified(),
      conductor.pollUnnotified(),
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sends).toBe(1);
  });

  test('failed notify retries on next tick', async () => {
    const gateway: any = { checkRateLimit: jest.fn().mockReturnValue(null) };
    const sendMessage = jest.fn().mockRejectedValue(new Error('net down'));
    const conductor = new Conductor({ gateway, tasks, channelManager: { sendMessage } as any, getEcosystem: () => ECO });

    const created = await tasks.create({
      origin_channel: 'telegram',
      origin_chat_id: 'chat-2',
      session_id: 's2',
      kind: 'user_request',
      input: 'hello',
    });
    await tasks.markDone(created.id, 'result text');

    await conductor.pollUnnotified();
    const row = await tasks.getById(created.id);
    expect(row?.notified_at).toBeNull();

    sendMessage.mockResolvedValue(undefined);
    await conductor.pollUnnotified();
    const row2 = await tasks.getById(created.id);
    expect(row2?.notified_at).not.toBeNull();
  });
});
