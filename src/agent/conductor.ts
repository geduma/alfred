import { ChannelMessage } from '../types/channel';
import { EcosystemConfig } from '../types/config';
import { Task } from '../types/task';
import { ChannelManager } from '../channels/channel-manager';
import { TaskRepository } from '../db/repositories/tasks';
import { Gateway } from '../gateway';
import { getLogger } from '../utils/logger';
import { CONDUCTOR_ACK } from './conductor-messages';
import { getDisplay } from '../services/display-strings';

export { CONDUCTOR_ACK };

export interface ConductorDeps {
  gateway: Gateway;
  tasks: TaskRepository;
  channelManager: ChannelManager;
  getEcosystem: () => EcosystemConfig;
}

const NOTIFY_MAX_ATTEMPTS = 3;
const NOTIFY_BASE_DELAY_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Conductor {
  private gateway: Gateway;
  private tasks: TaskRepository;
  private channelManager: ChannelManager;
  private getEcosystem: () => EcosystemConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notifying = false;
  private inFlight = new Set<string>();

  constructor(deps: ConductorDeps) {
    this.gateway = deps.gateway;
    this.tasks = deps.tasks;
    this.channelManager = deps.channelManager;
    this.getEcosystem = deps.getEcosystem;
  }

  async handleMessage(msg: ChannelMessage): Promise<string | null> {
    const denied = this.gateway.checkRateLimit(msg.channel, msg.userId);
    if (denied) return denied;

    const pending = await this.safeCountPending(msg.sessionId);
    const inputType = msg.metadata?.input_type === 'voice' ? 'voice' : 'text';
    if (pending > 0) {
      await this.tasks.create({
        origin_channel: msg.channel,
        origin_chat_id: msg.metadata?.chat_id !== undefined ? String(msg.metadata.chat_id) : msg.userId,
        session_id: msg.sessionId,
        kind: 'user_request',
        input: msg.content,
        input_type: inputType,
        max_attempts: this.getEcosystem().max_task_attempts,
      });
      return getDisplay('ack.queued_with_position', { pending });
    }

    const fast = await this.gateway.tryFastPath({
      channel: msg.channel,
      userId: msg.userId,
      userName: msg.userName,
      content: msg.content,
      sessionId: msg.sessionId,
      metadata: msg.metadata,
    }, { skipRateLimit: true });
    if (fast.completed) {
      return fast.text ?? null;
    }

    await this.tasks.create({
      origin_channel: msg.channel,
      origin_chat_id: msg.metadata?.chat_id !== undefined ? String(msg.metadata.chat_id) : msg.userId,
      session_id: msg.sessionId,
      kind: 'user_request',
      input: msg.content,
      input_type: inputType,
      max_attempts: this.getEcosystem().max_task_attempts,
    });
    return getDisplay('ack.enqueued');
  }

  private async safeCountPending(sessionId: string): Promise<number> {
    try {
      if (!sessionId) return 0;
      return await this.tasks.countPendingBySession(sessionId);
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Conductor pending count failed, falling back to fast path');
      return 0;
    }
  }

  async pollUnnotified(): Promise<void> {
    if (this.notifying) return;
    this.notifying = true;
    try {
      let pending: Task[];
      try {
        pending = await this.tasks.getUnnotified();
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'Conductor notify poll failed');
        return;
      }

      for (const task of pending) {
        if (this.inFlight.has(task.id)) continue;
        this.inFlight.add(task.id);
        try {
          await this.notifyWithRetry(task);
          await this.tasks.markNotified(task.id);
        } catch (error: any) {
          getLogger().warn({ taskId: task.id, error: error.message }, 'Conductor notify failed for task');
        } finally {
          this.inFlight.delete(task.id);
        }
      }
    } finally {
      this.notifying = false;
    }
  }

  private async notifyWithRetry(task: Task): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt++) {
      try {
        await this.notify(task);
        return;
      } catch (error: any) {
        lastError = error;
        getLogger().warn(
          { taskId: task.id, attempt, error: error.message },
          'Conductor notify attempt failed'
        );
        if (attempt < NOTIFY_MAX_ATTEMPTS) {
          await delay(NOTIFY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async notify(task: Task): Promise<void> {
    if (task.kind === 'proactive_check') {
      const target = this.getEcosystem().proactive_notify_to;
      if (!target) {
        getLogger().warn({ taskId: task.id }, 'Conductor skips proactive notify: proactive_notify_to is not configured');
        return;
      }
      const metadata = target.channel === 'telegram' ? { chat_id: target.chat_id } : undefined;
      await this.channelManager.sendMessage(target.channel, target.chat_id, this.format(task), metadata);
      return;
    }
    if (!task.origin_chat_id) {
      getLogger().warn({ taskId: task.id }, 'Conductor skips notify: watcher-only task');
      return;
    }
    const metadata = task.origin_channel === 'telegram'
      ? { chat_id: task.origin_chat_id, input_type: task.input_type || 'text' }
      : undefined;
    await this.channelManager.sendMessage(task.origin_channel, task.origin_chat_id, this.format(task), metadata);
  }

  private format(task: Task): string {
    if (task.status === 'done') {
      return task.result || getDisplay('task.done_fallback');
    }
    if (task.status === 'needs_approval') {
      return getDisplay('task.needs_approval', { result: task.result || '' }).trim();
    }
    return getDisplay('task.failed', { result: task.result || '' }).trim();
  }

  start(): void {
    const tick = (): void => {
      void this.pollUnnotified();
    };
    tick();
    this.timer = setInterval(tick, this.getEcosystem().conductor_poll_interval_ms);
    this.timer.unref?.();
    getLogger().info('Conductor notify loop started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
