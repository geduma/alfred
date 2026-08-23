import { spawn } from 'cross-spawn';
import { ChildProcess } from 'child_process';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';

const DEFAULT_DENIED_PATTERNS = [
  'rm -rf', 'dd', 'mkfs', ':(){:|:&', 'fork()', '> /dev/sda',
  'wget', 'curl', 'bash -c', 'sh -c', 'zsh -c', 'ksh -c', 'dash -c', 'fish -c',
  'python -c', 'perl -e', 'node -e', 'ruby -e', 'eval',
  '$(', '`', 'chmod', 'chown', 'sudo', 'passwd',
  'ssh ', 'scp ', 'base64', 'nc ', 'ncat',
  '/dev/tcp', '/dev/udp', '>:', '>>',
  '| sh', '| bash',
];

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
  killedBySignal?: string | null;
}

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
    const requestedTimeout = (params.timeout as number || this.timeout / 1000) * 1000;
    const timeout = Math.min(requestedTimeout, this.timeout);
    const env = params.env as Record<string, string> | undefined;

    if (!command) {
      return { success: false, output: '', error: 'Command is required' };
    }

    const { program, args } = this.parseCommand(command);
    const fullCommandForPolicy = `${program} ${args.join(' ')}`;
    const sanitizedForPolicy = this.sanitizeCommand(fullCommandForPolicy, env);

    const evasionReason = this.detectShellEvasion(command);
    if (evasionReason) {
      getLogger().warn(
        { command: sanitizedForPolicy, reason: evasionReason },
        'Command denied: shell metacharacter evasion'
      );
      return { success: false, output: '', error: 'Command denied by policy' };
    }

    if (!this.isCommandAllowed(sanitizedForPolicy)) {
      return { success: false, output: '', error: 'Command denied by policy' };
    }

    const startTime = Date.now();

    try {
      const result = await this.runCommand(program, args, {
        cwd,
        timeout,
        env: env ? { ...process.env, ...env } : undefined,
      });
      const durationMs = Date.now() - startTime;

      if (result.timedOut) {
        return {
          success: false,
          output: result.stdout.trim(),
          error: `Command timed out after ${timeout / 1000}s`,
          duration_ms: durationMs,
        };
      }

      return {
        success: result.status === 0,
        output: result.stdout.trim(),
        error: result.status !== 0
          ? result.stderr.trim() || (result.killedBySignal ? `Killed by signal ${result.killedBySignal}` : `Exit code: ${result.status}`)
          : undefined,
        exitCode: result.status ?? undefined,
        duration_ms: durationMs,
      };
    } catch (error: any) {
      return {
        success: false,
        output: '',
        error: error.message,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  private runCommand(
    program: string,
    args: string[],
    opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(program, args, {
          cwd: opts.cwd,
          env: opts.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: any) {
        resolve({ stdout: '', stderr: '', status: null, timedOut: false, killedBySignal: error.message });
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let completed = false;

      const terminate = () => {
        if (completed) return;
        timedOut = true;
        child.kill('SIGKILL');
      };

      const timer = setTimeout(terminate, opts.timeout);
      const onData = (stream: NodeJS.ReadableStream, kind: 'stdout' | 'stderr') => {
        (stream as NodeJS.ReadableStream & { on: (e: string, cb: (c: Buffer) => void) => void }).on('data', (chunk: Buffer) => {
          if (kind === 'stdout') {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_BUFFER_BYTES) {
              stdout += chunk.toString();
              terminate();
              return;
            }
            stdout += chunk.toString();
          } else {
            stderrBytes += chunk.length;
            if (stderrBytes > MAX_BUFFER_BYTES) {
              stderr += chunk.toString();
              terminate();
              return;
            }
            stderr += chunk.toString();
          }
        });
      };

      if (child.stdout) onData(child.stdout, 'stdout');
      if (child.stderr) onData(child.stderr, 'stderr');

      child.on('error', (err: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, status: null, timedOut: false, killedBySignal: err.message });
      });

      child.on('close', (code: number | null, signal: string | null) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, status: code, timedOut, killedBySignal: signal });
      });
    });
  }

  private parseCommand(command: string): { program: string; args: string[] } {
    const parts: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (const ch of command.trim()) {
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        } else {
          current += ch;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ' ') {
        if (current) {
          parts.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);

    return { program: parts[0] || '', args: parts.slice(1) };
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

  private normalizeWhitespace(cmd: string): string {
    return cmd.replace(/\s+/g, ' ').trim();
  }

  private stripAllWhitespace(cmd: string): string {
    return cmd.replace(/\s+/g, '');
  }

  private normalizeCommandFlags(cmd: string): string {
    return this.normalizeWhitespace(cmd)
      .replace(/-[a-zA-Z](?:\s+-[a-zA-Z])+/g, m => {
        const letters = m.match(/[a-zA-Z]/g)?.join('') || '';
        return `-${letters}`;
      });
  }

  private detectShellEvasion(cmd: string): string | null {
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      const next = cmd[i + 1] || '';

      if (inSingle) {
        if (ch === "'") inSingle = false;
        continue;
      }

      if (inDouble) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') { inDouble = false; continue; }
        if (ch === '`') return 'command_substitution_in_double_quotes';
        if (ch === '$' && /[A-Za-z_{(]/.test(next)) return 'variable_expansion_in_double_quotes';
        continue;
      }

      switch (ch) {
        case "'":
          inSingle = true;
          break;
        case '"':
          inDouble = true;
          break;
        case '\\':
          i++;
          break;
        case ';':
        case '&':
        case '|':
          return `shell_chaining:${ch}`;
        case '`':
          return 'command_substitution';
        case '\n':
        case '\r':
          return 'newline_in_command';
        case '<':
        case '>':
          if (next === '(') return 'process_substitution';
          break;
        case '$':
          if ('({'.includes(next) || /[A-Za-z_]/.test(next)) return 'variable_or_command_substitution';
          break;
      }
    }

    if (inSingle || inDouble) return 'unterminated_quote';
    return null;
  }

  private isCommandAllowed(command: string): boolean {
    const normalized = this.normalizeCommandFlags(command);
    const compact = this.stripAllWhitespace(normalized);
    const lower = normalized.toLowerCase();
    const lowerCompact = compact.toLowerCase();

    for (const pattern of this.deniedPatterns) {
      const p = pattern.toLowerCase();
      const pCompact = this.stripAllWhitespace(p);
      const isSingleWord = /^[a-z0-9_]+$/.test(p);
      const denied = isSingleWord
        ? new RegExp(`\\b${p}\\b`).test(lower) || new RegExp(`\\b${pCompact}\\b`).test(lowerCompact)
        : lower.includes(p) || lowerCompact.includes(pCompact);
      if (denied) {
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
