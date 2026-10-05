import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';
import { Conductor } from '../../src/agent/conductor';
import { ChannelManager } from '../../src/channels/channel-manager';

const ECO = {
  executor_poll_interval_ms: 50,
  conductor_poll_interval_ms: 50,
  sync_fast_path_timeout_ms: 8000,
  max_task_attempts: 2,
  orphan_reap_on_startup: true,
};

describe('Conductor notify retry', () => {
  let testDir: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
    tasks = new TaskRepository();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function finishTask(input: string): Promise<string> {
    const task = await tasks.create({
      origin_channel: 'cli',
      origin_chat_id: 'u1',
      session_id: 's1',
      kind: 'user_request',
      input,
    });
    await tasks.markDone(task.id, `result for ${input}`);
    return task.id;
  }

  test('transient failure retries and marks notified only after success', async () => {
    const id = await finishTask('q1');
    const sendMessage = jest.fn()
      .mockRejectedValueOnce(new Error('Telegram: Bad Request'))
      .mockResolvedValueOnce(undefined);
    const conductor = new Conductor({
      gateway: {} as any,
      tasks,
      channelManager: { sendMessage } as any,
      getEcosystem: () => ECO,
    });

    await conductor.pollUnnotified();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect((await tasks.getById(id))?.notified_at).not.toBeNull();
    expect(sendMessage.mock.calls[1][2]).toContain('result for q1');
  });

  test('persistent failure leaves the task unnotified for the next tick', async () => {
    const id = await finishTask('q2');
    const sendMessage = jest.fn().mockRejectedValue(new Error('network down'));
    const conductor = new Conductor({
      gateway: {} as any,
      tasks,
      channelManager: { sendMessage } as any,
      getEcosystem: () => ECO,
    });

    await conductor.pollUnnotified();

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect((await tasks.getById(id))?.notified_at).toBeNull();

    sendMessage.mockResolvedValue(undefined);
    await conductor.pollUnnotified();

    expect((await tasks.getById(id))?.notified_at).not.toBeNull();
    expect(sendMessage.mock.calls[3][2]).toContain('result for q2');
  });

  test('missing channel throws and keeps the task unnotified', async () => {
    const id = await finishTask('q3');
    const channelManager = new ChannelManager();
    const conductor = new Conductor({
      gateway: {} as any,
      tasks,
      channelManager,
      getEcosystem: () => ECO,
    });

    await conductor.pollUnnotified();

    expect((await tasks.getById(id))?.notified_at).toBeNull();
  });
});
