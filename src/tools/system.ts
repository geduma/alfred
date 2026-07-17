import fs from 'fs';
import { execSync } from 'child_process';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { ConfigLoader } from '../config/loader';

const LOG_PATH = '/workspace/logs/alfred.log';

export class SystemTool implements ToolHandler {
  private configLoader: ConfigLoader;

  tool: Tool = {
    name: 'system',
    description: 'Get Alfred\'s internal status, configuration, logs, or container health diagnostics',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'config', 'logs', 'health'] },
        filter: { type: 'string', description: 'Filter logs by keyword or severity (info, warn, error)' },
        lines: { type: 'number', description: 'Number of log lines to return (default: 20, max: 100)' },
      },
      required: ['action'],
    },
  };

  constructor(configLoader: ConfigLoader) {
    this.configLoader = configLoader;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'info':
        return this.info();
      case 'config':
        return this.getConfig();
      case 'logs':
        return this.getLogs(params);
      case 'health':
        return this.health();
      default:
        return { success: false, output: '', error: `Unknown action: ${action}` };
    }
  }

  private info(): ToolExecutionResult {
    const config = this.configLoader.allConfig;
    const providers = Object.entries(config.providers)
      .filter(([_, p]) => p.enabled)
      .map(([name, p]) => `  - ${name} (${p.type}, model: ${p.model})`);

    const channels = this.configLoader.enabledChannels
      .map(c => `  - ${c.name} (${c.config.type})`);

    const tools = ['exec', 'file_ops', 'web', 'job', 'system'];

    const info = [
      `Agent: ${config.agent.name} v${config.agent.version}`,
      '',
      'LLM Providers:',
      ...providers,
      `  Primary: ${config.llm.primary_provider}`,
      `  Fallback: ${config.llm.fallback_providers.join(', ') || 'none'}`,
      '',
      'Channels:',
      ...(channels.length ? channels : ['  (none enabled)']),
      '',
      'Tools:',
      ...tools.map(t => `  - ${t}`),
      '',
      `Database: ${config.database.config.path}`,
      `Logging: ${config.logging.level}`,
    ].join('\n');

    return { success: true, output: info };
  }

  private getConfig(): ToolExecutionResult {
    const config = this.configLoader.allConfig;
    const sanitized = JSON.parse(JSON.stringify(config));

    const maskKey = (key: string) => {
      if (!key || key.length < 8) return '***';
      return key.slice(0, 4) + '****' + key.slice(-4);
    };

    for (const [_, provider] of Object.entries(sanitized.providers) as any) {
      if (provider.config?.api_key) {
        provider.config.api_key = maskKey(provider.config.api_key);
      }
    }

    if (sanitized.security?.gateway_auth_token) {
      sanitized.security.gateway_auth_token = maskKey(sanitized.security.gateway_auth_token);
    }

    if (sanitized.channels?.telegram?.config?.bot_token) {
      sanitized.channels.telegram.config.bot_token = maskKey(sanitized.channels.telegram.config.bot_token);
    }

    return {
      success: true,
      output: JSON.stringify(sanitized, null, 2),
    };
  }

  private getLogs(params: Record<string, unknown>): ToolExecutionResult {
    const lines = Math.min((params.lines as number) || 20, 100);
    const filter = (params.filter as string) || '';

    if (!fs.existsSync(LOG_PATH)) {
      return { success: true, output: 'No log file found at /workspace/logs/alfred.log' };
    }

    try {
      const content = fs.readFileSync(LOG_PATH, 'utf-8');
      const allLines = content.trim().split('\n');

      let filtered = allLines;
      if (filter) {
        const lower = filter.toLowerCase();
        filtered = allLines.filter(l => l.toLowerCase().includes(lower));
      }

      const lastLines = filtered.slice(-lines);
      const totalAll = allLines.length;

      let output = `Log file: ${LOG_PATH}\n`;
      output += `Total lines: ${totalAll} | Showing last ${lastLines.length}${filter ? ` (filtered by "${filter}")` : ''}\n`;
      output += `---\n`;

      if (lastLines.length === 0) {
        output += '(no matching log entries)';
      } else {
        output += lastLines.join('\n');
      }

      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: '', error: `Failed to read logs: ${error.message}` };
    }
  }

  private health(): ToolExecutionResult {
    try {
      const memory = execSync('free -m 2>/dev/null || echo "N/A"', { encoding: 'utf-8', timeout: 5000 });
      const disk = execSync('df -h /workspace 2>/dev/null || echo "N/A"', { encoding: 'utf-8', timeout: 5000 });
      const nodeVersion = execSync('node -v', { encoding: 'utf-8', timeout: 5000 });
      const uptime = execSync('uptime 2>/dev/null || echo "N/A"', { encoding: 'utf-8', timeout: 5000 });

      const dbPath = this.configLoader.allConfig.database.config.path;
      let dbSize = 'N/A';
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        dbSize = `${(stats.size / 1024 / 1024).toFixed(1)} MB`;
      }

      const wsPort = 18789;
      const wsCheck = execSync(
        `node -e "const ws=require('ws');new ws('ws://127.0.0.1:${wsPort}').on('open',()=>{process.stdout.write('OK');process.exit(0)}).on('error',()=>{process.stdout.write('DOWN');process.exit(1)})"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      const output = [
        `Node.js: ${nodeVersion.trim()}`,
        `WebSocket (${wsPort}): ${wsCheck}`,
        `Database: ${dbSize}`,
        '',
        '— Memory —',
        memory.trim(),
        '',
        '— Disk —',
        disk.trim(),
        '',
        '— Uptime —',
        uptime.trim(),
      ].join('\n');

      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: '', error: `Health check failed: ${error.message}` };
    }
  }
}
