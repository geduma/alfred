import * as readline from 'readline';
import { Channel, ChannelMessage } from '../types/channel';
import { ChannelManager } from './channel-manager';
import { handleDirectCommand } from './cli-direct-commands';
import { getLogger } from '../utils/logger';

export class CLIChannel implements Channel {
  private channelManager: ChannelManager;
  private rl: readline.Interface | null = null;
  private running: boolean = false;

  constructor(channelManager: ChannelManager) {
    this.channelManager = channelManager;
  }

  async start(): Promise<void> {
    if (process.env.ALFRED_NO_CLI === '1') {
      getLogger().info('CLI channel disabled via ALFRED_NO_CLI, skipping interactive prompt');
      this.running = false;
      return;
    }
    if (!process.stdin.isTTY) {
      getLogger().info(
        'CLI channel disabled (stdin is not a TTY, e.g. systemd service). Use node system/alfred-cli.js for interactive CLI.'
      );
      this.running = false;
      return;
    }
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

      try {
        const direct = await handleDirectCommand(trimmed);
        if (direct !== null) {
          console.log(`\n${direct}\n`);
          if (this.running) {
            this.rl?.prompt();
          }
          return;
        }
      } catch (error: any) {
        console.error(`\n❌ Error: ${error.message}\n`);
        if (this.running) {
          this.rl?.prompt();
        }
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
      if (!this.running) return;
      if (!process.stdin.isTTY) {
        getLogger().info('CLI input closed (non-TTY), keeping gateway alive');
        this.running = false;
        this.rl = null;
        return;
      }
      getLogger().info('CLI channel closed by user (Ctrl+C)');
      this.exit(0);
    });
  }

  signalReady(): void {
    if (!this.rl) return;
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
