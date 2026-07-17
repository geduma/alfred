import { Channel, ChannelMessage } from '../types/channel';
import { ChannelManager } from './channel-manager';
import { getLogger } from '../utils/logger';

export class WhatsAppChannel implements Channel {
  private client: any = null;
  private channelManager: ChannelManager;
  private allowList: string[];
  private ready: boolean = false;
  private sessionFile?: string;

  constructor(channelManager: ChannelManager, config: Record<string, unknown>) {
    this.channelManager = channelManager;
    this.allowList = (config as any).permissions?.allow_from || [];
    this.sessionFile = (config as any).config?.session_file;
  }

  async start(): Promise<void> {
    const { Client, LocalAuth } = await import('whatsapp-web.js');
    this.client = new Client({
      puppeteer: { headless: true },
      ...(this.sessionFile
        ? { authStrategy: new LocalAuth({ dataPath: this.sessionFile }) }
        : {}),
    });
    this.client.on('qr', (qr: string) => {
      getLogger().info('WhatsApp QR code received. Scan with WhatsApp.');
      console.log('Scan this QR code with WhatsApp:\n', qr);
    });

    this.client.on('ready', () => {
      this.ready = true;
      getLogger().info('WhatsApp client is ready');
    });

    this.client.on('message', async (message: any) => {
      if (!this.ready) return;

      if (message.hasMedia) return;

      const userId = message.from;

      if (this.allowList.length > 0 && !this.allowList.includes(userId)) {
        getLogger().warn({ userId }, 'Unauthorized WhatsApp user');
        return;
      }

      const msg: ChannelMessage = {
        channel: 'whatsapp',
        userId,
        content: message.body,
        sessionId: `whatsapp_${userId}`,
        metadata: { chat_id: message.from },
      };

      if (!msg.content) return;

      try {
        const response = await this.channelManager.handleMessage(msg);
        if (response) {
          await message.reply(response);
        }
      } catch (error: any) {
        getLogger().error({ error: error.message }, 'WhatsApp message handling failed');
      }
    });

    this.client.on('disconnected', (reason: string) => {
      this.ready = false;
      getLogger().warn({ reason }, 'WhatsApp disconnected');
    });

    await this.client.initialize();
  }

  async sendMessage(userId: string, message: string): Promise<void> {
    if (!this.ready) {
      getLogger().warn('WhatsApp not ready, message queued');
      return;
    }
    await this.client.sendMessage(userId, message);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
