import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';
import { Conductor, CONDUCTOR_ACK } from '../../src/agent/conductor';
import { Executor } from '../../src/agent/executor';

const ECO = {
  executor_poll_interval_ms: 50,
  conductor_poll_interval_ms: 50,
  sync_fast_path_timeout_ms: 8000,
  max_task_attempts: 2,
  orphan_reap_on_startup: true,
};

describe('Conductor/Executor', () => {
  let testDir: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
    tasks = new TaskRepository();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('fast path should answer directly without touching tasks', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      tryFastPath: jest.fn().mockResolvedValue({ completed: true, text: 'son las 3' }),
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
      content: 'qué hora es',
      sessionId: 's1',
    });

    expect(reply).toBe('son las 3');
    expect(await tasks.countByStatus('pending')).toBe(0);
  });

  test('tool path should enqueue and acknowledge immediately', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null), tryFastPath: jest.fn().mockResolvedValue({ completed: false }) };
    const conductor = new Conductor({
      gateway,
      tasks,
      channelManager: { sendMessage: jest.fn() } as any,
      getEcosystem: () => ECO,
    });

    const reply = await conductor.handleMessage({
      channel: 'telegram',
      userId: 'u9',
      content: 'revisa el certificado',
      sessionId: 'telegram_u9',
      metadata: { chat_id: 'chat-9' },
    });

    expect(reply).toBe(CONDUCTOR_ACK);
    expect(await tasks.countByStatus('pending')).toBe(1);
    expect(await tasks.getUnnotified()).toHaveLength(0);
  });

  test('executor should run a pending task to done and conductor should notify once', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      tryFastPath: jest.fn().mockResolvedValue({ completed: false }),
      executeTask: jest.fn().mockResolvedValue({ content: 'vence en 12 días', blockedActions: [] }),
    };
    const sendMessage = jest.fn();
    const conductor = new Conductor({
      gateway,
      tasks,
      channelManager: { sendMessage } as any,
      getEcosystem: () => ECO,
    });
    const executor = new Executor({ gateway, tasks, getEcosystem: () => ECO });

    await conductor.handleMessage({ channel: 'cli', userId: 'u1', content: 'do', sessionId: 's1' });
    await executor.tick();
    expect(await tasks.countByStatus('done')).toBe(1);

    await conductor.pollUnnotified();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).toContain('vence en 12 días');

    await conductor.pollUnnotified();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('executor should retry then fail permanently', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      executeTask: jest.fn().mockRejectedValue(new Error('llm down')),
    };
    const executor = new Executor({ gateway, tasks, getEcosystem: () => ECO });

    await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'x', max_attempts: 2 });
    await executor.tick();
    expect(await tasks.countByStatus('pending')).toBe(1);
    await executor.tick();
    expect(await tasks.countByStatus('failed')).toBe(1);
    const [failed] = await tasks.getUnnotified();
    expect(failed.error_detail).toBe('llm down');
  });

  test('executor should mark needs_approval for blocked watcher tasks only', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      executeTask: jest.fn().mockResolvedValue({ content: 'blocked text', blockedActions: ['exec'] }),
    };
    const executor = new Executor({ gateway, tasks, getEcosystem: () => ECO });

    await tasks.create({ origin_channel: 'watcher', kind: 'proactive_check', input: 'rm' });
    await tasks.create({ origin_channel: 'cli', origin_chat_id: 'u1', kind: 'user_request', input: 'rm' });
    await executor.tick();
    await executor.tick();

    expect(await tasks.countByStatus('needs_approval')).toBe(1);
    expect(await tasks.countByStatus('done')).toBe(1);
  });

  test('orphaned running tasks should surface as failed notifications after restart', async () => {
    const created = await tasks.create({ origin_channel: 'cli', origin_chat_id: 'u1', kind: 'user_request', input: 'x' });
    tasks.claimNext();

    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),};
    const sendMessage = jest.fn();
    const conductor = new Conductor({
      gateway,
      tasks,
      channelManager: { sendMessage } as any,
      getEcosystem: () => ECO,
    });
    const executor = new Executor({ gateway, tasks, getEcosystem: () => ECO });
    executor.start();
    executor.stop();

    const row = await tasks.getById(created.id);
    expect(row?.status).toBe('failed');

    await conductor.pollUnnotified();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).toMatch(/could not be completed|no pudo completarse/);
  });
});
