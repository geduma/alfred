import { getLogger } from '../utils/logger';
import { HealthMonitorConfig } from '../types/notification';

export class NotificationService {
  private config: HealthMonitorConfig;
  private channelManager: any;

  constructor(config: HealthMonitorConfig, channelManager: any) {
    this.config = config;
    this.channelManager = channelManager;
  }

  async sendAlert(
    subject: string,
    body: string,
    severity: 'warn' | 'error' = 'error'
  ): Promise<void> {
    const notifications = this.config.notifications;

    if (notifications?.telegram?.enabled && this.channelManager) {
      try {
        const chatId = notifications.telegram.chat_id;
        const payload = `⚠️ *${severity === 'error' ? 'ERROR' : 'WARN'}* — ${subject}\n\n${body.slice(0, 3500)}`;
        if (chatId) {
          await this.channelManager.sendMessage('telegram', chatId, payload);
        } else {
          getLogger().info({ subject }, 'No telegram chat_id configured for alert');
        }
      } catch (err: any) {
        getLogger().warn({ error: err.message }, 'Telegram alert delivery failed');
      }
    }

    getLogger().info({ severity, subject }, 'Health alert logged');
  }
}
