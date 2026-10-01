import { runDoctor } from './doctor';
import { getLogger } from '../utils/logger';

export interface QuickActionDefinition {
  id: string;
  label: string;
  icon: string;
  hint: string;
  timeoutMs: number;
}

export interface QuickActionResult {
  action: string;
  ok: boolean;
  output: string;
  exitCode?: number | null;
  durationMs?: number;
  status?: string;
  truncated?: boolean;
}

const DEFINITIONS: QuickActionDefinition[] = [
  {
    id: 'doctor',
    label: 'Doctor',
    icon: '🩺',
    hint: 'Diagnóstico read-only (sin LLM)',
    timeoutMs: 60_000,
  },
];

export function listQuickActions(): QuickActionDefinition[] {
  return DEFINITIONS.map(d => ({ ...d }));
}

export async function runQuickAction(action: string): Promise<QuickActionResult> {
  const id = String(action || '').trim().toLowerCase();
  const def = DEFINITIONS.find(d => d.id === id);
  if (!def) {
    return { action: id, ok: false, output: `Unknown quick action: ${id}` };
  }
  if (id === 'doctor') {
    try {
      const r = await runDoctor();
      return {
        action: id,
        ok: true,
        output: r.output,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        status: r.status,
        truncated: r.truncated,
      };
    } catch (error: any) {
      getLogger().warn({ error: error?.message }, 'Quick action doctor failed');
      return { action: id, ok: false, output: `Doctor failed: ${error?.message || error}` };
    }
  }
  return { action: id, ok: false, output: `Quick action not implemented: ${id}` };
}
