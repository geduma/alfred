import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';

describe('TaskRepository', () => {
  let testDir: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
    tasks = new TaskRepository();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should create a pending task with defaults', async () => {
    const task = await tasks.create({
      origin_channel: 'telegram',
      origin_chat_id: 'user-1',
      session_id: 's1',
      kind: 'user_request',
      input: 'hola',
    });

    expect(task.status).toBe('pending');
    expect(task.attempts).toBe(0);
    expect(task.max_attempts).toBe(1);
    expect(task.notified_at).toBeNull();
  });

  test('should hand each pending task to exactly one claimant', async () => {
    await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'a' });
    await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'b' });

    const first = tasks.claimNext();
    const second = tasks.claimNext();
    const third = tasks.claimNext();

    expect(first?.input).toBe('a');
    expect(first?.status).toBe('running');
    expect(first?.attempts).toBe(1);
    expect(second?.input).toBe('b');
    expect(third).toBeNull();
  });

  test('should complete the done/failed lifecycle', async () => {
    const task = await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'x' });
    const claimed = tasks.claimNext();
    expect(claimed?.id).toBe(task.id);

    await tasks.markDone(task.id, 'ok');
    const done = await tasks.getById(task.id);
    expect(done?.status).toBe('done');
    expect(done?.result).toBe('ok');

    const other = await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'y' });
    tasks.claimNext();
    await tasks.markFailed(other.id, 'boom', 'stack');
    const failed = await tasks.getById(other.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error_detail).toBe('stack');
  });

  test('should reap orphaned running tasks on restart', async () => {
    const task = await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'z' });
    tasks.claimNext();

    const reaped = await tasks.reapOrphaned();

    expect(reaped).toBe(1);
    const row = await tasks.getById(task.id);
    expect(row?.status).toBe('failed');
    expect(row?.error_detail).toBe('orphaned_on_restart');
  });

  test('should list unnotified tasks once', async () => {
    const task = await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'w' });
    tasks.claimNext();
    await tasks.markDone(task.id, 'done-text');

    expect(await tasks.getUnnotified()).toHaveLength(1);
    await tasks.markNotified(task.id);
    expect(await tasks.getUnnotified()).toHaveLength(0);
  });

  test('should release a task back to pending for retry', async () => {
    const task = await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'r' });
    tasks.claimNext();
    await tasks.releaseForRetry(task.id);

    const again = tasks.claimNext();
    expect(again?.id).toBe(task.id);
    expect(again?.attempts).toBe(2);
  });
});
