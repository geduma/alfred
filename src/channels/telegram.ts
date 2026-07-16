import { Bot, Context } from 'grammy';
import { Channel, ChannelMessage } from '../types/channel';
import { ChannelManager } from './channel-manager';
import { getLogger } from '../utils/logger';

export class TelegramChannel implements Channel {
  private bot: Bot;
  private channelManager: ChannelManager;
  private allowList: string[];

  constructor(channelManager: ChannelManager, config: Record<string, unknown>) {
    this.channelManager = channelManager;
    this.allowList = (config as any).permissions?.allow_from || [];
    const token = (config as any).config?.bot_token as string;
    this.bot = new Bot(token);
  }

  async start(): Promise<void> {
    this.bot.on('message', async (ctx: Context) => {
      if (!ctx.message || !ctx.from) return;

      const userId = ctx.from.id.toString();

      if (this.allowList.length > 0 && !this.allowList.includes(userId)) {
        getLogger().warn({ userId }, 'Unauthorized Telegram user');
        return;
      }

      const msg: ChannelMessage = {
        channel: 'telegram',
        userId,
        userName: ctx.from.username || ctx.from.first_name,
        content: ctx.message.text || '',
        sessionId: `telegram_${userId}`,
        metadata: { chat_id: ctx.chat?.id },
      };

      if (!msg.content) return;

      try {
        const response = await this.channelManager.handleMessage(msg);
        if (response) {
          await this.sendMessage(userId, response, { chat_id: ctx.chat?.id });
        }
      } catch (error: any) {
        getLogger().error({ error: error.message }, 'Telegram message handling failed');
        await ctx.reply('Lo siento, ocurrió un error interno.');
      }
    });

    this.bot.start({
      onStart: () => getLogger().info('Telegram bot started'),
      drop_pending_updates: true,
    });

    getLogger().info('Telegram channel initialized');
  }

  async sendMessage(userId: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
    const chatId = metadata?.chat_id ? Number(metadata.chat_id) : Number(userId);
    await this.bot.api.sendMessage(chatId, message);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
