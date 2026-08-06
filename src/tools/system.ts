import fs from 'fs';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { ConfigLoader } from '../config/loader';
import { WORKSPACE_PATHS } from '../utils/workspace';

const exec = promisify(execCallback);
const LOG_PATH = WORKSPACE_PATHS.alfredLog();

export class SystemTool implements ToolHandler {
  private configLoader: ConfigLoader;
  private reloadHandler: (() => void) | null = null;

  tool: Tool = {
    name: 'system',
    description: 'Get Alfred\'s internal status, configuration, logs, container health diagnostics, or trigger config hot-reload',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'config', 'logs', 'health', 'reload'] },
        filter: { type: 'string', description: 'Filter logs by keyword or severity (info, warn, error)' },
        lines: { type: 'number', description: 'Number of log lines to return (default: 20, max: 100)' },
      },
      required: ['action'],
    },
  };

  constructor(configLoader: ConfigLoader) {
    this.configLoader = configLoader;
  }

  setReloadHandler(handler: () => void): void {
    this.reloadHandler = handler;
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
      case 'reload':
        return this.reload();
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

  private reload(): ToolExecutionResult {
    try {
      if (this.reloadHandler) {
        this.reloadHandler();
        return { success: true, output: '✅ Configuración recargada (config, providers y tools).' };
      }
      this.configLoader.reload();
      return { success: true, output: '✅ Configuración recargada desde disco. Los cambios se aplicarán en la siguiente solicitud al LLM.' };
    } catch (error: any) {
      return { success: false, output: '', error: `Failed to reload config: ${error.message}` };
    }
  }

  private async runShell(cmd: string): Promise<string> {
    try {
      const { stdout } = await exec(cmd, { encoding: 'utf-8', timeout: 5000 });
      return (stdout || '').trim() || 'N/A';
    } catch {
      return 'N/A';
    }
  }

  private async health(): Promise<ToolExecutionResult> {
    try {
      const [memory, disk, nodeVersion, uptime] = await Promise.all([
        this.runShell('free -m 2>/dev/null || echo "N/A"'),
        this.runShell('df -h /workspace 2>/dev/null || echo "N/A"'),
        this.runShell('node -v'),
        this.runShell('uptime 2>/dev/null || echo "N/A"'),
      ]);

      const dbPath = this.configLoader.allConfig.database.config.path;
      let dbSize = 'N/A';
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        dbSize = `${(stats.size / 1024 / 1024).toFixed(1)} MB`;
      }

      const wsPort = 18789;
      const wsCheck = await this.runShell(
        `node -e "const ws=require('ws');new ws('ws://127.0.0.1:${wsPort}').on('open',()=>{process.stdout.write('OK');process.exit(0)}).on('error',()=>{process.stdout.write('DOWN');process.exit(1)})"`
      );

      const output = [
        `Node.js: ${nodeVersion}`,
        `WebSocket (${wsPort}): ${wsCheck}`,
        `Database: ${dbSize}`,
        '',
        '— Memory —',
        memory,
        '',
        '— Disk —',
        disk,
        '',
        '— Uptime —',
        uptime,
      ].join('\n');

      return { success: true, output };
    } catch (error: any) {
      return { success: false, output: '', error: `Health check failed: ${error.message}` };
    }
  }
}
