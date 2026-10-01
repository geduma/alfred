import { ChannelMessage } from '../types/channel';
import { EcosystemConfig } from '../types/config';
import { Task } from '../types/task';
import { ChannelManager } from '../channels/channel-manager';
import { TaskRepository } from '../db/repositories/tasks';
import { Gateway } from '../gateway';
import { getLogger } from '../utils/logger';

export const CONDUCTOR_ACK = 'Entendido, trabajando en ello. Le aviso en cuanto termine.';

export interface ConductorDeps {
  gateway: Gateway;
  tasks: TaskRepository;
  channelManager: ChannelManager;
  getEcosystem: () => EcosystemConfig;
}

export class Conductor {
  private gateway: Gateway;
  private tasks: TaskRepository;
  private channelManager: ChannelManager;
  private getEcosystem: () => EcosystemConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ConductorDeps) {
    this.gateway = deps.gateway;
    this.tasks = deps.tasks;
    this.channelManager = deps.channelManager;
    this.getEcosystem = deps.getEcosystem;
  }

  async handleMessage(msg: ChannelMessage): Promise<string | null> {
    const fast = await this.gateway.tryFastPath({
      channel: msg.channel,
      userId: msg.userId,
      userName: msg.userName,
      content: msg.content,
      sessionId: msg.sessionId,
      metadata: msg.metadata,
    });
    if (fast.completed) {
      return fast.text ?? null;
    }

    await this.tasks.create({
      origin_channel: msg.channel,
      origin_chat_id: msg.metadata?.chat_id !== undefined ? String(msg.metadata.chat_id) : msg.userId,
      session_id: msg.sessionId,
      kind: 'user_request',
      input: msg.content,
      max_attempts: this.getEcosystem().max_task_attempts,
    });
    return CONDUCTOR_ACK;
  }

  async pollUnnotified(): Promise<void> {
    let pending: Task[];
    try {
      pending = await this.tasks.getUnnotified();
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Conductor notify poll failed');
      return;
    }

    for (const task of pending) {
      try {
        await this.notify(task);
        await this.tasks.markNotified(task.id);
      } catch (error: any) {
        getLogger().warn({ taskId: task.id, error: error.message }, 'Conductor notify failed for task');
      }
    }
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
    const metadata = task.origin_channel === 'telegram' ? { chat_id: task.origin_chat_id } : undefined;
    await this.channelManager.sendMessage(task.origin_channel, task.origin_chat_id, this.format(task), metadata);
  }

  private format(task: Task): string {
    if (task.status === 'done') {
      return task.result || 'Listo.';
    }
    if (task.status === 'needs_approval') {
      return `Necesito su aprobación antes de continuar:\n\n${task.result || ''}`.trim();
    }
    return `La tarea no pudo completarse: ${task.result || 'error desconocido'}\n¿Reintento?`.trim();
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
