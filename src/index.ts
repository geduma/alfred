import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { ConfigLoader } from './config/loader';
import { LLMRouter } from './agent/llm-router';
import { PromptBuilder } from './agent/prompt-builder';
import { Gateway } from './gateway';
import { ChannelManager } from './channels/channel-manager';
import { TelegramChannel } from './channels/telegram';
import { WhatsAppChannel } from './channels/whatsapp';
import { CLIChannel } from './channels/cli';
import { createTools } from './tools/index';
import { initializeDatabase } from './db/index';
import { initializeLogger, getLogger } from './utils/logger';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(__dirname, '../workspace/config/alfred.json');

function ensureConfigFiles(): void {
  const pairs = [
    { example: path.resolve(__dirname, '../system/alfred.json.example'), target: path.resolve(__dirname, '../workspace/config/alfred.json') },
    { example: path.resolve(__dirname, '../system/SOUL.md.example'), target: path.resolve(__dirname, '../workspace/config/SOUL.md') },
  ];

  for (const { example, target } of pairs) {
    if (!fs.existsSync(target) && fs.existsSync(example)) {
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.copyFileSync(example, target);
      console.log(`\n⚠️  Created ${target} from template.`);
      console.log(`   Edit this file with your API keys and settings before using Alfred.\n`);
    }
  }
}

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║     Alfred Pennyworth — AI Assistant      ║');
  console.log('║          Version 2.0.0                    ║');
  console.log('╚═══════════════════════════════════════════╝');

  console.log('\n🔧 Checking configuration files...');
  ensureConfigFiles();

  const configLoader = new ConfigLoader(CONFIG_PATH);
  const config = configLoader.allConfig;

  if (config.security.gateway_auth_token.startsWith('CHANGE_ME')) {
    const newToken = `rpi-alfred-${randomBytes(16).toString('hex')}`;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    raw.security.gateway_auth_token = newToken;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf-8');
    config.security.gateway_auth_token = newToken;
    console.log(`\n🔑 Gateway auth token auto-generated: ${newToken}`);
    console.log(`   Save this if you need external WebSocket clients.\n`);
  }

  initializeLogger(config.logging);

  getLogger().info('Alfred starting...');

  const promptBuilder = new PromptBuilder();
  try {
    await promptBuilder.loadSoul(configLoader.personalityFile);
    getLogger().info('SOUL.md loaded');
  } catch (error: any) {
    getLogger().warn({ error: error.message }, 'SOUL.md not found, using defaults');
  }

  const llmRouter = new LLMRouter(configLoader);
  try {
    await llmRouter.initialize();
  } catch (error: any) {
    getLogger().fatal({ error: error.message }, 'Failed to initialize LLM Router');
    process.exit(1);
  }

  const channelManager = new ChannelManager();

  const gateway = new Gateway(configLoader, llmRouter, promptBuilder, channelManager);

  const tools = createTools(configLoader);
  gateway.setTools(tools);
  getLogger().info({ tools: tools.map(t => t.tool.name) }, 'Tools registered');

  channelManager.setMessageHandler(async (msg) => {
    return gateway.processMessage(msg);
  });

  for (const { name, config: chConfig } of configLoader.enabledChannels) {
    switch (chConfig.type) {
      case 'telegram':
        channelManager.register(name, new TelegramChannel(channelManager, {
          config: chConfig.config,
          permissions: chConfig.permissions,
        }));
        break;
      case 'whatsapp':
        channelManager.register(name, new WhatsAppChannel(channelManager, {
          config: chConfig.config,
          permissions: chConfig.permissions,
        }));
        break;
      case 'cli':
        channelManager.register(name, new CLIChannel(channelManager));
        break;
      default:
        getLogger().warn({ type: chConfig.type }, 'Unknown channel type, skipping');
    }
  }

  const dbPath = configLoader.database.config.path;
  try {
    await initializeDatabase(dbPath);
  } catch (error: any) {
    getLogger().warn({ error: error.message }, 'Database initialization failed, continuing without persistence');
  }

  try {
    await gateway.start();
    getLogger().info('Alfred is ready');
    channelManager.signalReady();
  } catch (error: any) {
    getLogger().fatal({ error: error.message }, 'Failed to start gateway');
    process.exit(1);
  }
}

function shutdown(): void {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // stdin may not be a TTY, ignore
  }
  try {
    process.stdout.write('\n');
  } catch {
    // stdout may be closed
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (error) => {
  getLogger().fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  getLogger().fatal({ error: reason?.message }, 'Unhandled rejection');
  process.exit(1);
});

main();
