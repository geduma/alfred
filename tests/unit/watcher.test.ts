import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';
import { Watcher, evaluateNotifyIf } from '../../src/services/watcher';
import { Conductor } from '../../src/agent/conductor';

const ECO: any = {
  executor_poll_interval_ms: 50,
  conductor_poll_interval_ms: 50,
  sync_fast_path_timeout_ms: 8000,
  max_task_attempts: 2,
  orphan_reap_on_startup: true,
};

function buildWatcher(overrides: any = {}) {
  const tasks = new TaskRepository();
  const deps = {
    tasks,
    skillLoader: { loadSkills: jest.fn().mockResolvedValue([]) },
    jobScheduler: { fireDueJobs: jest.fn().mockResolvedValue(undefined) },
    channelManager: {} as any,
    getHealthMonitor: () => null,
    getSeverityThreshold: () => 'warn' as const,
    onJobFire: jest.fn().mockResolvedValue(undefined),
    runCheck: jest.fn(),
    getEcosystem: () => ECO,
    ...overrides,
  };
  return { watcher: new Watcher(deps), tasks, deps };
}

describe('Watcher', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should enqueue new health findings above threshold only once', async () => {
    const findings = [
      { severity: 'error', category: 'database', message: 'disk full', count: 3, first_seen: 't', last_seen: 't', sample: 's' },
      { severity: 'warn', category: 'tool_execution', message: 'slow exec', count: 1, first_seen: 't', last_seen: 't', sample: 's' },
    ];
    const { watcher, tasks } = buildWatcher({
      getHealthMonitor: () => ({ getFindings: jest.fn().mockResolvedValue(findings) }),
    });

    await watcher.tick();
    expect(await tasks.countByStatus('pending')).toBe(2);

    await watcher.tick();
    expect(await tasks.countByStatus('pending')).toBe(2);
  });

  test('should filter findings below the error threshold', async () => {
    const findings = [
      { severity: 'warn', category: 'session', message: 'minor', count: 1, first_seen: 't', last_seen: 't', sample: 's' },
    ];
    const { watcher, tasks } = buildWatcher({
      getHealthMonitor: () => ({ getFindings: jest.fn().mockResolvedValue(findings) }),
      getSeverityThreshold: () => 'error' as const,
    });

    await watcher.tick();
    expect(await tasks.countByStatus('pending')).toBe(0);
  });

  test('should escalate stale unnotified failures exactly once', async () => {
    const { watcher, tasks } = buildWatcher();
    const old = await tasks.create({ origin_channel: 'telegram', origin_chat_id: 'u1', kind: 'user_request', input: 'x' });
    tasks.claimNext();
    await tasks.markFailed(old.id, 'boom');
    getDatabase().prepare('UPDATE tasks SET finished_at = ? WHERE id = ?')
      .run(Date.now() - 11 * 60 * 1000, old.id);

    const fresh = await tasks.create({ origin_channel: 'cli', kind: 'user_request', input: 'y' });
    tasks.claimNext();
    await tasks.markFailed(fresh.id, 'recent');

    await watcher.tick();
    const proactive = getDatabase().prepare("SELECT * FROM tasks WHERE kind = 'proactive_check'").all() as any[];
    expect(proactive).toHaveLength(1);
    expect(proactive[0].input).toContain(old.id);

    await watcher.tick();
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'proactive_check'").get() as any).n).toBe(1);
  });

  test('should fire skill conditions and respect cooldown', async () => {
    const skills = [
      {
        name: 'ssl-cert-check',
        description: 'd',
        instructions: 'i',
        filePath: 'f',
        trigger: { type: 'condition', check_tool: 'exec', check_command: 'check-cert', notify_if: 'days_remaining < 14' },
      },
    ];
    const runCheck = jest.fn().mockResolvedValue('{"days_remaining": 9}');
    const { watcher, tasks, deps } = buildWatcher({
      skillLoader: { loadSkills: jest.fn().mockResolvedValue(skills) },
      runCheck,
    });

    await watcher.tick();
    expect(await tasks.countByStatus('pending')).toBe(1);

    await watcher.tick();
    expect(await tasks.countByStatus('pending')).toBe(1);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(deps.skillLoader.loadSkills).toHaveBeenCalled();
  });

  test('should skip false conditions, malformed triggers and schedule types', async () => {
    const skills = [
      { name: 'a', description: 'd', instructions: 'i', filePath: 'f', trigger: { type: 'condition', check_tool: 'exec', check_command: 'c', notify_if: 'days_remaining < 14' } },
      { name: 'b', description: 'd', instructions: 'i', filePath: 'f', trigger: { type: 'condition', check_tool: 'exec' } },
      { name: 'c', description: 'd', instructions: 'i', filePath: 'f', trigger: { type: 'schedule', cron: '0 8 * * *' } },
      { name: 'd', description: 'd', instructions: 'i', filePath: 'f' },
    ];
    const { watcher, tasks } = buildWatcher({
      skillLoader: { loadSkills: jest.fn().mockResolvedValue(skills) },
      runCheck: jest.fn().mockResolvedValue('{"days_remaining": 90}'),
    });

    await watcher.tick();
    expect(await tasks.countByStatus('pending')).toBe(0);
  });

  test('should still fire time-based jobs on every tick', async () => {
    const onJobFire = jest.fn().mockResolvedValue(undefined);
    const fireDueJobs = jest.fn().mockImplementation(async (_cm: any, cb: any) => {
      await cb({ id: 'j1' });
    });
    const { watcher } = buildWatcher({ onJobFire, jobScheduler: { fireDueJobs } });

    await watcher.tick();
    expect(fireDueJobs).toHaveBeenCalledTimes(1);
    expect(onJobFire).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateNotifyIf', () => {
  test.each([
    ['days_remaining < 14', '{"days_remaining": 9}', true],
    ['days_remaining < 14', '{"days_remaining": 30}', false],
    ['days_remaining <= 14', '{"days_remaining": 14}', true],
    ['count >= 3', '{"count": 5}', true],
    ['status == 1', '{"status": 1}', true],
    ['status != 1', '{"status": 2}', true],
    ['value < 10', '7', true],
    ['value < 10', '12', false],
    ['days_remaining < 14', '{"other": 1}', false],
    ['days_remaining < 14', 'not a number', false],
  ])('should evaluate %s against %s as %s', (expr, stdout, expected) => {
    expect(evaluateNotifyIf(expr, stdout)).toBe(expected);
  });

  test('should reject arbitrary code', () => {
    expect(() => evaluateNotifyIf('process.exit(1)', '{}')).toThrow();
  });
});

describe('Conductor proactive routing', () => {
  let testDir2: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-'));
    await initializeDatabase(path.join(testDir2, 'test.db'));
    tasks = new TaskRepository();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir2, { recursive: true, force: true });
  });

  test('should deliver proactive tasks to the configured target', async () => {
    const sendMessage = jest.fn();
    const conductor = new Conductor({
      gateway: {} as any,
      tasks,
      channelManager: { sendMessage } as any,
      getEcosystem: () => ({ ...ECO, proactive_notify_to: { channel: 'telegram', chat_id: 'admin-1' } }),
    });

    const task = await tasks.create({ origin_channel: 'watcher', kind: 'proactive_check', input: 'x' });
    tasks.claimNext();
    await tasks.markDone(task.id, 'certificado en 12 días');

    await conductor.pollUnnotified();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0].slice(0, 3)).toEqual(['telegram', 'admin-1', expect.stringContaining('12 días')]);
    expect(sendMessage.mock.calls[0][3]).toEqual({ chat_id: 'admin-1' });
  });

  test('should skip proactive notify without a target but still mark notified', async () => {
    const sendMessage = jest.fn();
    const conductor = new Conductor({
      gateway: {} as any,
      tasks,
      channelManager: { sendMessage } as any,
      getEcosystem: () => ECO,
    });

    const task = await tasks.create({ origin_channel: 'watcher', kind: 'proactive_check', input: 'x' });
    tasks.claimNext();
    await tasks.markDone(task.id, 'done');

    await conductor.pollUnnotified();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await tasks.getUnnotified()).toHaveLength(0);
  });
});
