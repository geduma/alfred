import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getLogger } from '../utils/logger';

export const DOCTOR_TIMEOUT_MS = 25_000;
export const DOCTOR_MAX_OUTPUT_CHARS = 12_000;

export interface DoctorResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  scriptPath: string;
  status: 'ok' | 'warnings' | 'failures' | 'error';
}

function candidateScriptPaths(): string[] {
  const here = __dirname;
  return [
    path.resolve(here, '../../scripts/alfred-doctor.sh'),
    path.resolve(here, '../scripts/alfred-doctor.sh'),
    path.resolve(process.cwd(), 'scripts/alfred-doctor.sh'),
    '/app/scripts/alfred-doctor.sh',
  ];
}

export function resolveDoctorScript(): string | null {
  for (const p of candidateScriptPaths()) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // try next
    }
  }
  return null;
}

function statusForExit(code: number | null, timedOut: boolean): DoctorResult['status'] {
  if (timedOut || code === null) return 'error';
  if (code === 0) return 'ok';
  if (code === 1) return 'warnings';
  return 'failures';
}

export async function runDoctor(opts?: {
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<DoctorResult> {
  const scriptPath = resolveDoctorScript();
  const startedAt = Date.now();
  if (!scriptPath) {
    return {
      output: 'alfred-doctor.sh not found (expected in scripts/).',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      truncated: false,
      scriptPath: '(missing)',
      status: 'error',
    };
  }

  const timeoutMs = Math.min(opts?.timeoutMs ?? DOCTOR_TIMEOUT_MS, 60_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts?.env || {}),
  };
  // Fixed allowlist: never pass user input through.
  for (const k of ['SERVICE_NAME', 'WORKSPACE_DIR', 'PORT', 'SINCE', 'CONFIG_PATH']) {
    if (opts?.env?.[k] !== undefined) env[k] = opts.env[k];
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '');
      let truncated = false;
      let output = combined.trim() || '(sin salida)';
      if (output.length > DOCTOR_MAX_OUTPUT_CHARS) {
        truncated = true;
        output = output.slice(0, DOCTOR_MAX_OUTPUT_CHARS) + '\n… [truncado]';
      }
      const durationMs = Date.now() - startedAt;
      getLogger().info({ exitCode, durationMs, timedOut }, 'Doctor check finished');
      resolve({
        output,
        exitCode,
        durationMs,
        timedOut,
        truncated,
        scriptPath,
        status: statusForExit(exitCode, timedOut),
      });
    };

    let child;
    try {
      child = spawn('bash', [scriptPath], {
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    // Avoid keeping the event loop alive on failure paths.
    (timer as any).unref?.();

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', () => finish(null));
    child.on('close', (code: number | null) => finish(code));
  });
}
