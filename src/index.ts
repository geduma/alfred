import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { ConfigLoader } from './config/loader';
import { LLMRouter } from './agent/llm-router';
import { PromptBuilder } from './agent/prompt-builder';
import { Gateway } from './gateway';
import { ChannelManager } from './channels/channel-manager';
import { TelegramChannel } from './channels/telegram';
import { CLIChannel } from './channels/cli';
import { WebChannel } from './channels/web';
import { initializeDatabase, closeDatabase } from './db/index';
import { initializeLogger, getLogger } from './utils/logger';
import { WORKSPACE_ROOT, WORKSPACE_PATHS } from './utils/workspace';

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(WORKSPACE_ROOT, 'config', 'alfred.json');

const REQUIRED_DIRS = [
  'config',
  'db',
  'files',
  'logs',
  'memory',
  'memory/sessions',
  'memory/jobs',
  'memory/personality',
  'memory/vectors',
  'memory/snapshots',
  'skills',
  'skills/custom',
  'skills/files',
  'skills/system',
  'skills/web',
];

async function ensureWorkspace(): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    await fs.promises.mkdir(path.join(WORKSPACE_ROOT, dir), { recursive: true }).catch(() => {});
  }

  const pairs = [
    { example: path.resolve(__dirname, '../system/alfred.json.example'), target: path.join(WORKSPACE_ROOT, 'config', 'alfred.json') },
    { example: path.resolve(__dirname, '../system/SOUL.md.example'), target: path.join(WORKSPACE_ROOT, 'config', 'SOUL.md') },
    { example: path.resolve(__dirname, '../system/secrets.env.example'), target: path.join(WORKSPACE_ROOT, 'config', 'secrets.env') },
    { example: path.resolve(__dirname, '../system/preferences.md.example'), target: WORKSPACE_PATHS.preferences() },
  ];

  for (const { example, target } of pairs) {
    try {
      await fs.promises.access(target);
    } catch {
      try {
        await fs.promises.access(example);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(example, target);
        console.log(`\n⚠️  Created ${target} from template.`);
        console.log(`   Edit this file with your API keys and settings before using Alfred.\n`);
      } catch {
        // example doesn't exist, skip
      }
    }
  }

  await copyDefaultSkills();
}

async function copyDefaultSkills(): Promise<void> {
  const sourceDir = path.resolve(__dirname, '../system/skills-custom');
  const targetDir = path.join(WORKSPACE_ROOT, 'skills', 'custom');

  let files: string[];
  try {
    files = await fs.promises.readdir(sourceDir);
  } catch {
    return;
  }

  await fs.promises.mkdir(targetDir, { recursive: true }).catch(() => {});
  const skillFiles = files.filter(f => f.endsWith('.md'));

  for (const file of skillFiles) {
    const target = path.join(targetDir, file);
    try {
      await fs.promises.access(target);
    } catch {
      try {
        await fs.promises.copyFile(path.join(sourceDir, file), target);
        console.log(`📄 Copied default skill ${file} to ${target}`);
      } catch {
        // skip on failure
      }
    }
  }
}

let gateway: Gateway | null = null;

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║          Alfred — AI Assistant            ║');
  console.log('║          Version 2.2.0                    ║');
  console.log('╚═══════════════════════════════════════════╝');

  console.log('\n🔧 Checking configuration files...');
  await ensureWorkspace();

  const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  if (rawConfig?.security?.gateway_auth_token?.startsWith('CHANGE_ME')) {
    const newToken = `rpi-alfred-${randomBytes(16).toString('hex')}`;
    rawConfig.security.gateway_auth_token = newToken;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(rawConfig, null, 2), 'utf-8');
    console.log(`\n🔑 Gateway auth token auto-generated: ${newToken}`);
    console.log(`   Save this if you need external WebSocket clients.\n`);
  }

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
    await shutdown('llm_init_failure');
    return;
  }

  const channelManager = new ChannelManager();

  let webChannel: WebChannel | null = null;
  for (const { name, config: chConfig } of configLoader.enabledChannels) {
    switch (chConfig.type) {
      case 'telegram':
        channelManager.register(name, new TelegramChannel(channelManager, {
          config: chConfig.config,
          permissions: chConfig.permissions,
          voice: configLoader.allConfig.voice,
        }));
        break;
      case 'cli':
        channelManager.register(name, new CLIChannel(channelManager));
        break;
      case 'web':
        webChannel = new WebChannel();
        channelManager.register(name, webChannel);
        break;
      default:
        getLogger().warn({ type: chConfig.type }, 'Unknown channel type, skipping');
    }
  }

  gateway = new Gateway(configLoader, llmRouter, promptBuilder, channelManager, webChannel);

  channelManager.setMessageHandler(async (msg) => {
    return gateway ? gateway.processMessage(msg) : null;
  });

  const dbPath = configLoader.database.config.path;
  try {
    await initializeDatabase(dbPath);
    getLogger().info({ dbPath }, 'Database initialized');
  } catch (error: any) {
    getLogger().warn({ error: error.message }, 'Database initialization failed, continuing without persistence');
  }

  try {
    await gateway.start();
    getLogger().info('Alfred is ready');
    channelManager.signalReady();
  } catch (error: any) {
    getLogger().fatal({ error: error.message }, 'Failed to start gateway');
    await shutdown('gateway_failure');
  }
}

async function shutdown(reason = 'signal'): Promise<void> {
  getLogger().info({ reason }, 'Shutting down...');
  try {
    if (gateway) {
      await gateway.stop();
    }
    await closeDatabase();
  } catch (error: any) {
    getLogger().warn({ error: error.message }, 'Error during shutdown');
  }
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

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

process.on('uncaughtException', (error) => {
  getLogger().fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  void shutdown('uncaught_exception');
});

process.on('unhandledRejection', (reason: any) => {
  getLogger().fatal({ error: reason?.message }, 'Unhandled rejection');
  void shutdown('unhandled_rejection');
});

main().catch(async (error: any) => {
  getLogger().fatal({ error: error.message }, 'Fatal startup error');
  await shutdown('fatal_error');
});
