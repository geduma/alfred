import { execSync } from 'child_process';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';

const DEFAULT_DENIED_PATTERNS = ['rm -rf', 'dd', 'mkfs', ':(){:|:&', 'fork()', '> /dev/sda'];

export class ExecTool implements ToolHandler {
  private allowedPatterns: string[];
  private deniedPatterns: string[];
  private timeout: number;

  tool: Tool = {
    name: 'exec',
    description: 'Execute shell commands',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables (secrets are sanitized from logs)' },
      },
      required: ['command'],
    },
  };

  constructor(config?: {
    allowed_patterns?: string[];
    denied_patterns?: string[];
    timeout_seconds?: number;
  }) {
    this.allowedPatterns = config?.allowed_patterns || [];
    this.deniedPatterns = config?.denied_patterns || DEFAULT_DENIED_PATTERNS;
    this.timeout = (config?.timeout_seconds || 30) * 1000;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const command = params.command as string;
    const cwd = (params.cwd as string) || process.cwd();
    const timeout = (params.timeout as number || this.timeout / 1000) * 1000;
    const env = params.env as Record<string, string> | undefined;

    if (!command) {
      return { success: false, output: '', error: 'Command is required' };
    }

    const sanitizedCommand = this.sanitizeCommand(command, env);
    if (!this.isCommandAllowed(sanitizedCommand)) {
      return { success: false, output: '', error: 'Command denied by policy' };
    }

    const startTime = Date.now();

    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : undefined,
      });

      return {
        success: true,
        output: output.trim(),
        duration_ms: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        output: error.stdout?.trim() || '',
        error: error.stderr?.trim() || error.message,
        exitCode: error.status,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  private sanitizeCommand(command: string, env?: Record<string, string>): string {
    if (!env) return command;
    let sanitized = command;
    for (const value of Object.values(env)) {
      if (value) {
        sanitized = sanitized.split(value).join('***');
      }
    }
    return sanitized;
  }

  private isCommandAllowed(command: string): boolean {
    const lower = command.toLowerCase();

    for (const pattern of this.deniedPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        getLogger().warn({ command, pattern }, 'Command denied by pattern');
        return false;
      }
    }

    if (this.allowedPatterns.length > 0) {
      const allowed = this.allowedPatterns.some(p => lower.startsWith(p.toLowerCase()));
      if (!allowed) {
        getLogger().warn({ command }, 'Command not in allowed patterns');
        return false;
      }
    }

    return true;
  }
}
