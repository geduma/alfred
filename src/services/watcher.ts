import { EcosystemConfig } from '../types/config';
import { HealthFinding } from '../types/notification';
import { TaskRepository } from '../db/repositories/tasks';
import { HealthMonitor } from './health-monitor';
import { SkillLoader } from './skill-loader';
import { JobSchedulerTool, Job } from '../tools/job-scheduler';
import { ChannelManager } from '../channels/channel-manager';
import { getLogger } from '../utils/logger';

export const WATCHER_INTERVAL_MS = 30_000;
export const FAILED_NOTIFY_GRACE_MS = 10 * 60 * 1000;
export const DEFAULT_CONDITION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN_FINDINGS = 1000;

export interface WatcherDeps {
  tasks: TaskRepository;
  skillLoader: SkillLoader;
  jobScheduler: JobSchedulerTool;
  channelManager: ChannelManager;
  getHealthMonitor: () => HealthMonitor | null;
  getSeverityThreshold: () => 'warn' | 'error';
  onJobFire: (job: Job) => Promise<void>;
  runCheck: (command: string) => Promise<string>;
  getEcosystem: () => EcosystemConfig;
}

export function evaluateNotifyIf(expression: string, stdout: string): boolean {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(expression);
  if (!match) {
    throw new Error(`Unsupported notify_if expression: ${expression}`);
  }
  const [, name, operator, rawExpected] = match;
  const expected = Number(rawExpected);
  let actual: number | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === 'number') actual = value;
      else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) actual = Number(value);
    } else if (typeof parsed === 'number') {
      actual = parsed;
    }
  } catch {
    const trimmed = stdout.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) actual = Number(trimmed);
  }
  if (actual === null || !Number.isFinite(actual)) return false;

  switch (operator) {
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    default: return false;
  }
}

function meetsThreshold(severity: 'warn' | 'error', threshold: 'warn' | 'error'): boolean {
  return threshold === 'warn' ? true : severity === 'error';
}

export class Watcher {
  private tasks: TaskRepository;
  private skillLoader: SkillLoader;
  private jobScheduler: JobSchedulerTool;
  private channelManager: ChannelManager;
  private getHealthMonitor: () => HealthMonitor | null;
  private getSeverityThreshold: () => 'warn' | 'error';
  private onJobFire: (job: Job) => Promise<void>;
  private runCheck: (command: string) => Promise<string>;
  private getEcosystem: () => EcosystemConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenFindings = new Set<string>();
  private escalatedFailures = new Set<string>();
  private lastConditionFire = new Map<string, number>();
  private scheduleWarned = new Set<string>();

  constructor(deps: WatcherDeps) {
    this.tasks = deps.tasks;
    this.skillLoader = deps.skillLoader;
    this.jobScheduler = deps.jobScheduler;
    this.channelManager = deps.channelManager;
    this.getHealthMonitor = deps.getHealthMonitor;
    this.getSeverityThreshold = deps.getSeverityThreshold;
    this.onJobFire = deps.onJobFire;
    this.runCheck = deps.runCheck;
    this.getEcosystem = deps.getEcosystem;
  }

  async tick(): Promise<void> {
    try {
      await this.jobScheduler.fireDueJobs(this.channelManager, (job) => this.onJobFire(job));
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Watcher time-based firing failed');
    }
    await this.checkHealthFindings();
    await this.checkFailedSafetyNet();
    await this.checkSkillConditions();
  }

  private async checkHealthFindings(): Promise<void> {
    const monitor = this.getHealthMonitor();
    if (!monitor) return;
    let findings: HealthFinding[];
    try {
      findings = await monitor.getFindings();
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Watcher health scan failed');
      return;
    }
    const threshold = this.getSeverityThreshold();
    for (const finding of findings) {
      if (!meetsThreshold(finding.severity, threshold)) continue;
      const signature = `${finding.severity}|${finding.category}|${finding.message}`;
      if (this.seenFindings.has(signature)) continue;
      this.seenFindings.add(signature);
      if (this.seenFindings.size > MAX_SEEN_FINDINGS) {
        const oldest = this.seenFindings.values().next();
        if (!oldest.done) this.seenFindings.delete(oldest.value);
      }
      try {
        await this.tasks.create({
          origin_channel: 'watcher',
          kind: 'proactive_check',
          input: `Health finding [${finding.severity}/${finding.category}]: ${finding.message} (visto ${finding.count}x, último: ${finding.last_seen}). Investiga y resume el estado.`,
          max_attempts: this.getEcosystem().max_task_attempts,
        });
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'Watcher failed to enqueue health task');
      }
    }
  }

  private async checkFailedSafetyNet(): Promise<void> {
    let stale: Awaited<ReturnType<TaskRepository['getStaleUnnotifiedFailures']>>;
    try {
      stale = await this.tasks.getStaleUnnotifiedFailures(FAILED_NOTIFY_GRACE_MS);
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Watcher safety-net query failed');
      return;
    }
    for (const task of stale) {
      if (this.escalatedFailures.has(task.id)) continue;
      this.escalatedFailures.add(task.id);
      try {
        await this.tasks.create({
          origin_channel: 'watcher',
          kind: 'proactive_check',
          input: `La tarea ${task.id} (${task.kind}, origen ${task.origin_channel}) falló y no pudo notificarse: ${task.result || 'sin detalle'}. Revisa y avisa.`,
          max_attempts: this.getEcosystem().max_task_attempts,
        });
        getLogger().warn({ taskId: task.id }, 'Watcher escalated an unnotified failed task');
      } catch (error: any) {
        getLogger().warn({ taskId: task.id, error: error.message }, 'Watcher failed to escalate task');
      }
    }
  }

  private async checkSkillConditions(): Promise<void> {
    let skills: Awaited<ReturnType<SkillLoader['loadSkills']>>;
    try {
      skills = await this.skillLoader.loadSkills();
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Watcher skill scan failed');
      return;
    }
    for (const skill of skills) {
      if (!skill.trigger) continue;
      if (skill.trigger.type === 'schedule') {
        if (!this.scheduleWarned.has(skill.name)) {
          this.scheduleWarned.add(skill.name);
          getLogger().warn({ skill: skill.name }, 'Watcher ignores schedule-type skill trigger (not supported in v3.0)');
        }
        continue;
      }
      if (skill.trigger.type !== 'condition') continue;
      if (skill.trigger.check_tool !== 'exec' || !skill.trigger.check_command || !skill.trigger.notify_if) {
        getLogger().warn({ skill: skill.name }, 'Watcher skips malformed condition trigger');
        continue;
      }
      const cooldownMs = (skill.trigger.cooldown_hours ?? 24) * 60 * 60 * 1000 || DEFAULT_CONDITION_COOLDOWN_MS;
      if (Date.now() - (this.lastConditionFire.get(skill.name) ?? 0) < cooldownMs) continue;
      let output: string;
      try {
        output = await this.runCheck(skill.trigger.check_command);
      } catch (error: any) {
        getLogger().warn({ skill: skill.name, error: error.message }, 'Watcher condition check failed');
        continue;
      }
      let fires: boolean;
      try {
        fires = evaluateNotifyIf(skill.trigger.notify_if, output);
      } catch (error: any) {
        getLogger().warn({ skill: skill.name, error: error.message }, 'Watcher condition expression invalid');
        continue;
      }
      if (!fires) continue;
      this.lastConditionFire.set(skill.name, Date.now());
      try {
        await this.tasks.create({
          origin_channel: 'watcher',
          kind: 'proactive_check',
          skill_name: skill.name,
          input: `Condición cumplida para la skill "${skill.name}" (${skill.trigger.notify_if}). Ejecuta la skill "${skill.name}".`,
          max_attempts: this.getEcosystem().max_task_attempts,
        });
      } catch (error: any) {
        getLogger().warn({ skill: skill.name, error: error.message }, 'Watcher failed to enqueue condition task');
      }
    }
  }

  start(): void {
    const tick = (): void => {
      void this.tick();
    };
    tick();
    this.timer = setInterval(tick, WATCHER_INTERVAL_MS);
    this.timer.unref?.();
    getLogger().info('Watcher started (jobs + event triggers)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
