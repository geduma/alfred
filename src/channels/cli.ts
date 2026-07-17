import * as readline from 'readline';
import { Channel, ChannelMessage } from '../types/channel';
import { ChannelManager } from './channel-manager';

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
        console.log('\n👋 Goodbye, Señor Felipe.\n');
        this.running = false;
        this.rl?.close();
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
        this.running = false;
        process.exit(0);
      }
    });
  }

  signalReady(): void {
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║   ✅ Alfred is running!                   ║');
    console.log('║   WebSocket: ws://127.0.0.1:18789          ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(' Escribe "exit" para salir\n');
    this.rl?.prompt();
  }

  async sendMessage(_userId: string, message: string): Promise<void> {
    console.log(`\n[Alfred] ${message}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.rl) {
      this.rl.close();
    }
  }
}
