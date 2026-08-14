import * as readline from 'readline';
import { Channel, ChannelMessage } from '../types/channel';
import { ChannelManager } from './channel-manager';
import { getLogger } from '../utils/logger';

export class CLIChannel implements Channel {
  private channelManager: ChannelManager;
  private rl: readline.Interface | null = null;
  private running: boolean = false;

  constructor(channelManager: ChannelManager) {
    this.channelManager = channelManager;
  }

  async start(): Promise<void> {
    this.running = true;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '🧐 ',
    });

    this.rl.on('line', async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\n👋 Goodbye.\n');
        this.exit(0);
        return;
      }

      const msg: ChannelMessage = {
        channel: 'cli',
        userId: 'cli_user',
        content: trimmed,
        sessionId: 'cli_session',
      };

      try {
        const response = await this.channelManager.handleMessage(msg);
        if (response) {
          console.log(`\n🤖 ${response}\n`);
        }
      } catch (error: any) {
        console.error(`\n❌ Error: ${error.message}\n`);
      }

      if (this.running) {
        this.rl?.prompt();
      }
    });

    this.rl.on('close', () => {
      if (this.running) {
        getLogger().info('CLI channel closed by user (Ctrl+C)');
        this.exit(0);
      }
    });
  }

  signalReady(): void {
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║   ✅ Alfred is running!                   ║');
    console.log('║   WebSocket: ws://127.0.0.1:18789          ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(' Type "exit" to quit\n');
    this.rl?.prompt();
  }

  async sendMessage(_userId: string, message: string): Promise<void> {
    console.log(`\n[Alfred] ${message}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.restoreStdin();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private restoreStdin(): void {
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // stdin may not be a TTY, ignore
    }
  }

  private exit(code: number): void {
    this.running = false;
    this.restoreStdin();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    process.exit(code);
  }
}
