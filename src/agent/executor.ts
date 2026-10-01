import { EcosystemConfig } from '../types/config';
import { Task } from '../types/task';
import { TaskRepository } from '../db/repositories/tasks';
import { Gateway } from '../gateway';
import { getLogger } from '../utils/logger';

export interface ExecutorDeps {
  gateway: Gateway;
  tasks: TaskRepository;
  getEcosystem: () => EcosystemConfig;
}

export class Executor {
  private gateway: Gateway;
  private tasks: TaskRepository;
  private getEcosystem: () => EcosystemConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(deps: ExecutorDeps) {
    this.gateway = deps.gateway;
    this.tasks = deps.tasks;
    this.getEcosystem = deps.getEcosystem;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const task = this.tasks.claimNext();
      if (!task) return;
      await this.run(task);
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Executor tick failed');
    } finally {
      this.busy = false;
    }
  }

  private async run(task: Task): Promise<void> {
    const maxAttempts = task.max_attempts || this.getEcosystem().max_task_attempts;
    let content: string | null;
    let blockedActions: string[];
    try {
      const result = await this.gateway.executeTask(task);
      content = result.content;
      blockedActions = result.blockedActions;
    } catch (error: any) {
      if (task.attempts < maxAttempts) {
        getLogger().warn(
          { taskId: task.id, attempt: task.attempts, error: error.message },
          'Executor task failed, released for retry'
        );
        await this.tasks.releaseForRetry(task.id);
        return;
      }
      getLogger().error({ taskId: task.id, error: error.message }, 'Executor task failed permanently');
      await this.tasks.markFailed(task.id, 'La tarea falló tras varios intentos.', error.message);
      return;
    }

    const text = content || 'Listo.';
    if (blockedActions.length > 0 && task.kind !== 'user_request') {
      await this.tasks.markNeedsApproval(task.id, text);
      return;
    }
    await this.tasks.markDone(task.id, text);
  }

  start(): void {
    const eco = this.getEcosystem();
    if (eco.orphan_reap_on_startup) {
      void this.tasks.reapOrphaned().then((n) => {
        if (n > 0) getLogger().warn({ count: n }, 'Executor reaped orphaned tasks');
      }).catch((error: any) => {
        getLogger().warn({ error: error.message }, 'Executor orphan reap failed');
      });
    }
    const tick = (): void => {
      void this.tick();
    };
    this.timer = setInterval(tick, this.getEcosystem().executor_poll_interval_ms);
    this.timer.unref?.();
    getLogger().info('Executor poll loop started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
