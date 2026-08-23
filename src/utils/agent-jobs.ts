import fs from 'fs';
import path from 'path';
import { WORKSPACE_PATHS } from './workspace';

export function findAgentJobs(jobsDir: string = WORKSPACE_PATHS.jobs()): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }

  const agentJobs: string[] = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), 'utf-8'));
      if (job && job.mode === 'agent' && job.enabled !== false) {
        agentJobs.push(job.id || file);
      }
    } catch {
      continue;
    }
  }
  return agentJobs;
}

export function spendingLimitsWarningActive(
  llmConfig?: { spending_limits?: { enabled?: boolean } | null },
  jobsDir?: string
): boolean {
  return findAgentJobs(jobsDir).length > 0 && !llmConfig?.spending_limits?.enabled;
}
