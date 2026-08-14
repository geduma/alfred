import { Bot, Context, InputFile } from 'grammy';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Channel, ChannelMessage } from '../types/channel';
import { ChannelManager } from './channel-manager';
import { getLogger } from '../utils/logger';
import { VoiceService } from '../services/voice';
import { VoiceConfig } from '../types/config';
import { WORKSPACE_PATHS } from '../utils/workspace';

const VOICE_REPLY_MARKER = '[AUDIO]';
const MAX_CAPTION_LENGTH = 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export class TelegramChannel implements Channel {
  private bot: Bot;
  private channelManager: ChannelManager;
  private allowList: string[];
  private token: string;
  private voiceConfig: VoiceConfig | null = null;
  private voiceService: VoiceService | null = null;

  constructor(channelManager: ChannelManager, config: Record<string, unknown>) {
    this.channelManager = channelManager;
    this.allowList = (config as any).permissions?.allow_from || [];
    this.token = (config as any).config?.bot_token as string;
    this.voiceConfig = config.voice as VoiceConfig | null;
    if (this.voiceConfig?.enabled) {
      this.voiceService = new VoiceService(this.voiceConfig);
    }
    this.bot = new Bot(this.token);
  }

  async start(): Promise<void> {
    this.bot.on('message', async (ctx: Context) => {
      if (!ctx.message || !ctx.from) return;

      const userId = ctx.from.id.toString();

      if (this.allowList.length > 0 && !this.allowList.includes(userId)) {
        getLogger().warn({ userId }, 'Unauthorized Telegram user');
        return;
      }

      const chatId = ctx.chat?.id;
      if (!chatId) return;

      let text = ctx.message.text || '';
      let inputType = 'text';
      let detectedLanguage: string | undefined;

      if (!text && this.voiceService && (ctx.message.voice || ctx.message.audio)) {
        const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
        if (fileId) {
          const ext = ctx.message.audio?.file_name?.split('.').pop()
            || (ctx.message.voice ? 'ogg' : 'm4a');
          const tempPath = path.join(
            WORKSPACE_PATHS.files(), 'audio', 'incoming', `${ctx.message.message_id}.${ext}`
          );

          try {
            const file = await ctx.api.getFile(fileId);
            if (!file.file_path) throw new Error('Telegram file path missing');
            const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
            const response = await axios.get(downloadUrl, {
              responseType: 'arraybuffer',
              timeout: DOWNLOAD_TIMEOUT_MS,
              maxContentLength: MAX_DOWNLOAD_BYTES,
            });

            await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
            await fs.promises.writeFile(tempPath, Buffer.from(response.data));

            const transcript = await this.voiceService.transcribe(tempPath);
            text = transcript.text;
            detectedLanguage = transcript.language;
            inputType = 'voice';
          } catch (error: any) {
            getLogger().error({ error: error.message, userId }, 'Voice message processing failed');
            await ctx.reply("I could not understand the audio.").catch(() => {});
            return;
          } finally {
            await fs.promises.unlink(tempPath).catch(() => {});
          }
        }
      }

      if (!text) return;

      const msg: ChannelMessage = {
        channel: 'telegram',
        userId,
        userName: ctx.from.username || ctx.from.first_name,
        content: text,
        sessionId: `telegram_${userId}`,
        metadata: {
          chat_id: chatId,
          input_type: inputType,
          ...(detectedLanguage ? { speaches_language: detectedLanguage } : {}),
        },
      };

      ctx.api.sendChatAction(chatId, 'typing').catch(() => {});

      const typingInterval = setInterval(() => {
        ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);

      try {
        const response = await this.channelManager.handleMessage(msg);
        clearInterval(typingInterval);

        if (response) {
          const { text: replyText, synthesizeVoice } = this.shouldSynthesizeVoice(response);
          if (synthesizeVoice && this.voiceService) {
            try {
              const audio = await this.voiceService.synthesize(replyText);
              await this.bot.api.sendAudio(chatId, new InputFile(audio, 'alfred.wav'), {
                caption: replyText.slice(0, MAX_CAPTION_LENGTH),
              });
            } catch (error: any) {
              getLogger().error({ error: error.message, userId }, 'Voice reply synthesis failed, falling back to text');
              await this.sendMessage(userId, replyText, { chat_id: chatId });
            }
          } else {
            await this.sendMessage(userId, replyText, { chat_id: chatId });
          }
        } else {
          getLogger().warn({ userId }, 'Empty response from handler');
          await ctx.reply("I'm sorry, I didn't get a response. Could you repeat that?");
        }
      } catch (error: any) {
        clearInterval(typingInterval);
        getLogger().error({ error: error.message }, 'Telegram message handling failed');
        await ctx.reply("I'm sorry, an internal error occurred.").catch(() => {});
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
    try {
      await this.bot.api.sendMessage(chatId, message);
    } catch (error: any) {
      getLogger().error({ error: error.message, chatId }, 'Telegram sendMessage failed');
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private shouldSynthesizeVoice(response: string): { text: string; synthesizeVoice: boolean } {
    const markerMatch = response.match(/\n?\[AUDIO\]\s*$/);
    let text = response;
    if (markerMatch) {
      text = response.slice(0, response.length - markerMatch[0].length).trimEnd();
    }

    if (!this.voiceService || !this.voiceConfig) {
      return { text, synthesizeVoice: false };
    }

    if (markerMatch && this.voiceService.isExposedToModel()) {
      return { text, synthesizeVoice: true };
    }

    return { text, synthesizeVoice: false };
  }
}

export { VOICE_REPLY_MARKER };
