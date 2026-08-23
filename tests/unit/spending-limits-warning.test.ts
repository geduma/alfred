import fs from 'fs';
import path from 'path';
import os from 'os';
import { findAgentJobs, spendingLimitsWarningActive } from '../../src/utils/agent-jobs';
import { HealthMonitor } from '../../src/services/health-monitor';

describe('findAgentJobs', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-jobs-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('detects enabled agent-mode jobs', () => {
    fs.writeFileSync(
      path.join(testDir, 'j1.json'),
      JSON.stringify({ id: 'j1', mode: 'agent', enabled: true, message: 'x' }),
      'utf-8'
    );
    expect(findAgentJobs(testDir)).toEqual(['j1']);
  });

  test('ignores reminder jobs and disabled agent jobs', () => {
    fs.writeFileSync(
      path.join(testDir, 'r1.json'),
      JSON.stringify({ id: 'r1', mode: 'reminder', enabled: true }),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(testDir, 'a2.json'),
      JSON.stringify({ id: 'a2', mode: 'agent', enabled: false }),
      'utf-8'
    );
    expect(findAgentJobs(testDir)).toEqual([]);
  });

  test('returns empty for missing dir and tolerates corrupt files', () => {
    expect(findAgentJobs(path.join(testDir, 'nope'))).toEqual([]);
    fs.writeFileSync(path.join(testDir, 'broken.json'), '{not json', 'utf-8');
    fs.writeFileSync(
      path.join(testDir, 'good.json'),
      JSON.stringify({ id: 'good', mode: 'agent' }),
      'utf-8'
    );
    expect(findAgentJobs(testDir)).toEqual(['good']);
  });
});

describe('spendingLimitsWarningActive', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-warn-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function seedJob(mode = 'agent'): void {
    fs.writeFileSync(
      path.join(testDir, 'job.json'),
      JSON.stringify({ id: 'job', mode, enabled: true }),
      'utf-8'
    );
  }

  test('active when agent job exists and spending_limits missing', () => {
    seedJob();
    expect(spendingLimitsWarningActive({}, testDir)).toBe(true);
    expect(spendingLimitsWarningActive(undefined, testDir)).toBe(true);
  });

  test('inactive when limits enabled or no agent jobs', () => {
    seedJob();
    expect(spendingLimitsWarningActive({ spending_limits: { enabled: true } }, testDir)).toBe(false);

    seedJob('reminder');
    expect(spendingLimitsWarningActive(undefined, testDir)).toBe(false);
  });
});

describe('HealthMonitor static findings', () => {
  const baseConfig = {
    enabled: true,
    check_interval_minutes: 60,
    severity_threshold: 'warn' as const,
    notifications: {},
  };

  function makeMonitor(logPath: string): HealthMonitor {
    return new HealthMonitor(baseConfig, { sendAlert: jest.fn() } as any, logPath);
  }

  test('getFindings merges static findings even without log file', async () => {
    const monitor = makeMonitor(path.join(os.tmpdir(), `no-such-log-${Date.now()}.log`));
    monitor.addStaticFinding({
      severity: 'warn',
      category: 'config',
      message: 'Agent-mode jobs configured without spending_limits',
      count: 1,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      sample: 'sample',
    });
    const findings = await monitor.getFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('config');
    expect(findings[0].message).toContain('spending_limits');
  });

  test('without static findings and no log file returns empty', async () => {
    const monitor = makeMonitor(path.join(os.tmpdir(), `no-such-log-${Date.now()}.log`));
    expect(await monitor.getFindings()).toEqual([]);
  });
});
