import { Channel, ChannelMessage } from '../types/channel';
import { getLogger } from '../utils/logger';

export class ChannelManager {
  private channels: Map<string, Channel> = new Map();
  private messageHandler: ((msg: ChannelMessage) => Promise<string | null>) | null = null;

  register(name: string, channel: Channel): void {
    this.channels.set(name, channel);
    getLogger().info({ channel: name }, 'Channel registered');
  }

  setMessageHandler(handler: (msg: ChannelMessage) => Promise<string | null>): void {
    this.messageHandler = handler;
  }

  async startAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.start();
        getLogger().info({ channel: name }, 'Channel started');
      } catch (error: any) {
        getLogger().error({ channel: name, error: error.message }, 'Failed to start channel');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        if (channel.stop) {
          await channel.stop();
        }
        getLogger().info({ channel: name }, 'Channel stopped');
      } catch (error: any) {
        getLogger().error({ channel: name, error: error.message }, 'Failed to stop channel');
      }
    }
  }

  async sendMessage(channelName: string, userId: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      getLogger().warn({ channel: channelName }, 'Channel not found for sending message');
      return;
    }
    await channel.sendMessage(userId, message, metadata);
  }

  async handleMessage(msg: ChannelMessage): Promise<string | null> {
    if (!this.messageHandler) {
      getLogger().warn('No message handler set');
      return null;
    }
    return this.messageHandler(msg);
  }
}
