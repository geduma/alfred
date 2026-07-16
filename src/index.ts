import path from 'path';
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

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║     Alfred Pennyworth — AI Assistant      ║');
  console.log('║          Version 2.0.0                    ║');
  console.log('╚═══════════════════════════════════════════╝');

  const configLoader = new ConfigLoader(CONFIG_PATH);
  const config = configLoader.allConfig;

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
    console.log('\n✅ Alfred is running!');
    console.log('   WebSocket: ws://127.0.0.1:18789');
    console.log('   Press Ctrl+C to stop.\n');
  } catch (error: any) {
    getLogger().fatal({ error: error.message }, 'Failed to start gateway');
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  getLogger().info('Shutting down Alfred...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  getLogger().info('Shutting down Alfred...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  getLogger().fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  getLogger().fatal({ error: reason?.message }, 'Unhandled rejection');
  process.exit(1);
});

main();
