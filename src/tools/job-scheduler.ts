import fs from 'fs';
import path from 'path';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';
import { WORKSPACE_PATHS } from '../utils/workspace';

const JOB_FILE_CACHE: Map<string, Job> = new Map();

interface JobContext {
  channel?: string;
  userId?: string;
  chat_id?: string | number;
}

export interface Job {
  id: string;
  message: string;
  created_at: string;
  created_by: {
    channel: string;
    user_id: string;
    chat_id?: string | number;
  };
  notification_channels: string[] | null;
  schedule: JobSchedule;
  next_fire: string | null;
  last_fired: string | null;
  enabled: boolean;
}

export interface JobSchedule {
  type: 'once' | 'daily' | 'weekly' | 'monthly';
  trigger_at?: string;
  hour?: number;
  minute?: number;
  day_of_week?: number[];
  day_of_month?: number[];
  human?: string;
}

export class JobSchedulerTool implements ToolHandler {
  private jobsDir: string;

  constructor(jobsDir?: string) {
    this.jobsDir = jobsDir || WORKSPACE_PATHS.jobs();
  }

  tool: Tool = {
    name: 'job',
    description: 'Schedule, list, update, or cancel reminders and delayed tasks',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'cancel'] },
        job_id: { type: 'string', description: 'Required for update and cancel' },
        message: { type: 'string', description: 'Required for create' },
        delay_minutes: { type: 'number', description: 'For one-time reminders (e.g. 5 for "in 5 minutes")' },
        cron_hour: { type: 'number', description: 'Hour for recurring (0-23)' },
        cron_minute: { type: 'number', description: 'Minute for recurring (0-59)' },
        cron_day_of_week: { type: 'array', items: { type: 'number' }, description: 'Days of week (0=Sun, 1=Mon, ..., 6=Sat)' },
        cron_day_of_month: { type: 'array', items: { type: 'number' }, description: 'Days of month (1-31)' },
        human: { type: 'string', description: 'Human readable description of the schedule' },
        channel: { type: 'string', description: 'Specific channel to notify (default: all active channels)' },
        enabled: { type: 'boolean', description: 'Enable or disable a job' },
      },
      required: ['action'],
    },
  };

  private async ensureDir(): Promise<void> {
    await fs.promises.mkdir(this.jobsDir, { recursive: true }).catch(() => {});
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = params.action as string;
    await this.ensureDir();

    switch (action) {
      case 'create':
        return this.create(params);
      case 'list':
        return await this.list();
      case 'update':
        return await this.update(params);
      case 'cancel':
        return await this.cancel(params);
      default:
        return { success: false, output: '', error: `Unknown action: ${action}` };
    }
  }

  private create(params: Record<string, unknown>): ToolExecutionResult {
    const message = params.message as string;
    if (!message) {
      return { success: false, output: '', error: 'message is required for create' };
    }

    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const schedule = this.buildSchedule(params);
    if (!schedule) {
      return { success: false, output: '', error: 'Could not parse schedule. Provide delay_minutes or cron fields.' };
    }

    const job: Job = {
      id,
      message,
      created_at: new Date().toISOString(),
      created_by: {
        channel: (params.__context as JobContext | undefined)?.channel || 'cli',
        user_id: (params.__context as JobContext | undefined)?.userId || 'cli_user',
        chat_id: (params.__context as JobContext | undefined)?.chat_id,
      },
      notification_channels: params.channel ? [params.channel as string] : null,
      schedule,
      next_fire: this.computeNextFire(schedule),
      last_fired: null,
      enabled: true,
    };

    this.saveJob(job);
    getLogger().info({ jobId: id, schedule: schedule.human || 'one-time' }, 'Job created');

    return {
      success: true,
      output: `Reminder created (ID: ${id}). ${schedule.human ? `Schedule: ${schedule.human}` : `Will fire at ${schedule.trigger_at}`}`,
    };
  }

  private async list(): Promise<ToolExecutionResult> {
    const jobs = await this.loadAllJobs();
    const active = jobs.filter(j => j.enabled);

    if (active.length === 0) {
      return { success: true, output: 'No active reminders.' };
    }

    const output = active.map((j, i) => {
      const nextFire = j.next_fire ? new Date(j.next_fire).toLocaleString() : 'N/A';
      return `[${i + 1}] ${j.message}\n    ID: ${j.id}\n    Next: ${nextFire}\n    Schedule: ${j.schedule.human || j.schedule.type}\n    Enabled: ${j.enabled}`;
    }).join('\n\n');

    return { success: true, output: `Active reminders:\n\n${output}` };
  }

  private async update(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const jobId = params.job_id as string;
    if (!jobId) {
      return { success: false, output: '', error: 'job_id is required for update' };
    }

    const job = await this.loadJob(jobId);
    if (!job) {
      return { success: false, output: '', error: `Job ${jobId} not found` };
    }

    const updates: string[] = [];

    if (params.message) {
      job.message = params.message as string;
      updates.push('message');
    }
    if (params.enabled !== undefined) {
      job.enabled = params.enabled as boolean;
      updates.push('enabled');
    }
    if (params.delay_minutes || params.cron_hour !== undefined) {
      const schedule = this.buildSchedule(params);
      if (schedule) {
        job.schedule = schedule;
        job.next_fire = this.computeNextFire(schedule);
        updates.push('schedule');
      }
    }
    if (params.channel) {
      job.notification_channels = [params.channel as string];
      updates.push('notification channel');
    }

    this.saveJob(job);
    return { success: true, output: `Job ${jobId} updated (${updates.join(', ')}).` };
  }

  private async cancel(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const jobId = params.job_id as string;
    if (!jobId) {
      return { success: false, output: '', error: 'job_id is required for cancel' };
    }

    const exists = await this.jobExists(jobId);
    if (!exists) {
      return { success: false, output: '', error: `Job ${jobId} not found` };
    }

    await this.deleteJobFile(jobId);
    JOB_FILE_CACHE.delete(jobId);
    return { success: true, output: `Reminder ${jobId} cancelled.` };
  }

  private buildSchedule(params: Record<string, unknown>): JobSchedule | null {
    if (params.delay_minutes) {
      const minutes = params.delay_minutes as number;
      const triggerAt = new Date(Date.now() + minutes * 60000).toISOString();
      return {
        type: 'once',
        trigger_at: triggerAt,
        human: `in ${minutes} minute${minutes !== 1 ? 's' : ''}`,
      };
    }

    const hour = params.cron_hour as number | undefined;
    const minute = params.cron_minute as number | undefined;
    const dayOfWeek = params.cron_day_of_week as number[] | undefined;
    const dayOfMonth = params.cron_day_of_month as number[] | undefined;

    if (hour !== undefined && minute !== undefined) {
      if (dayOfWeek) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = dayOfWeek.map(d => dayNames[d]).join(', ');
        return {
          type: 'weekly',
          hour,
          minute,
          day_of_week: dayOfWeek,
          human: `every ${days} at ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
        };
      }
      if (dayOfMonth) {
        return {
          type: 'monthly',
          hour,
          minute,
          day_of_month: dayOfMonth,
          human: `on day(s) ${dayOfMonth.join(', ')} at ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
        };
      }
      return {
        type: 'daily',
        hour,
        minute,
        human: `every day at ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
      };
    }

    return null;
  }

  private computeNextFire(schedule: JobSchedule): string | null {
    if (schedule.type === 'once' && schedule.trigger_at) {
      return schedule.trigger_at;
    }

    const now = new Date();
    const next = new Date(now);

    if (schedule.type === 'daily' && schedule.hour !== undefined && schedule.minute !== undefined) {
      next.setHours(schedule.hour, schedule.minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }

    if (schedule.type === 'weekly' && schedule.day_of_week && schedule.hour !== undefined && schedule.minute !== undefined) {
      for (let d = 0; d < 7; d++) {
        const candidate = new Date(now);
        candidate.setDate(candidate.getDate() + d);
        candidate.setHours(schedule.hour, schedule.minute, 0, 0);
        if (schedule.day_of_week.includes(candidate.getDay()) && candidate > now) {
          return candidate.toISOString();
        }
      }
    }

    if (schedule.type === 'monthly' && schedule.day_of_month && schedule.hour !== undefined && schedule.minute !== undefined) {
      const monthDays = schedule.day_of_month;
      for (const day of monthDays.sort((a, b) => a - b)) {
        const candidate = new Date(now.getFullYear(), now.getMonth(), day, schedule.hour, schedule.minute, 0, 0);
        if (candidate > now) return candidate.toISOString();
      }
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, monthDays[0], schedule.hour, schedule.minute, 0, 0);
      return nextMonth.toISOString();
    }

    return null;
  }

  async loadAllJobs(): Promise<Job[]> {
    if (JOB_FILE_CACHE.size > 0) {
      return Array.from(JOB_FILE_CACHE.values());
    }

    let files: string[];
    try {
      files = await fs.promises.readdir(this.jobsDir);
    } catch {
      return [];
    }

    const jobs = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          try {
            return JSON.parse(await fs.promises.readFile(path.join(this.jobsDir, f), 'utf-8')) as Job;
          } catch {
            return null;
          }
        })
    );

    const validJobs = jobs.filter((j): j is Job => j !== null);
    for (const job of validJobs) {
      JOB_FILE_CACHE.set(job.id, job);
    }
    return validJobs;
  }

  private async loadJob(jobId: string): Promise<Job | null> {
    const cached = JOB_FILE_CACHE.get(jobId);
    if (cached) return cached;

    const fp = this.jobFilePath(jobId);
    try {
      const data = await fs.promises.readFile(fp, 'utf-8');
      const job = JSON.parse(data) as Job;
      JOB_FILE_CACHE.set(jobId, job);
      return job;
    } catch {
      return null;
    }
  }

  private async jobExists(jobId: string): Promise<boolean> {
    if (JOB_FILE_CACHE.has(jobId)) return true;
    try {
      await fs.promises.access(this.jobFilePath(jobId));
      return true;
    } catch {
      return false;
    }
  }

  clearCache(): void {
    JOB_FILE_CACHE.clear();
  }

  async fireDueJobs(channelManager: any): Promise<void> {
    const now = Date.now();
    const jobs = await this.loadAllJobs();

    await Promise.all(jobs.map(async (job) => {
      if (!job.enabled || !job.next_fire) return;

      const fireTime = new Date(job.next_fire).getTime();
      if (fireTime <= now) {
        getLogger().info({ jobId: job.id, message: job.message }, 'Firing job');

        try {
          await this.deliver(job, channelManager);
        } catch (error: any) {
          getLogger().error({ jobId: job.id, error: error.message }, 'Job delivery failed');
        }

        if (job.schedule.type === 'once') {
          await this.deleteJobFile(job.id);
          JOB_FILE_CACHE.delete(job.id);
        } else {
          job.last_fired = new Date().toISOString();
          job.next_fire = this.computeNextFire(job.schedule);
          this.saveJob(job);
        }
      }
    }));
  }

  private async deliver(job: Job, channelManager: any): Promise<void> {
    const metadata = job.created_by.chat_id !== undefined ? { chat_id: job.created_by.chat_id } : undefined;
    const reminder = `⏰ Reminder: ${job.message}`;

    if (job.notification_channels) {
      await Promise.all(
        job.notification_channels.map(ch =>
          channelManager.sendMessage(ch, job.created_by.user_id, reminder, metadata)
        )
      );
    } else {
      await channelManager.sendMessage(job.created_by.channel, job.created_by.user_id, reminder, metadata);
    }
  }

  private saveJob(job: Job): void {
    JOB_FILE_CACHE.set(job.id, job);
    fs.promises.writeFile(this.jobFilePath(job.id), JSON.stringify(job), 'utf-8').catch(err => {
      getLogger().error({ error: err.message, jobId: job.id }, 'Failed to save job');
    });
  }

  private async deleteJobFile(id: string): Promise<void> {
    const fp = this.jobFilePath(id);
    try {
      await fs.promises.unlink(fp);
    } catch { /* not found */ }
  }

  private jobFilePath(id: string): string {
    return path.join(this.jobsDir, `${id}.json`);
  }
}