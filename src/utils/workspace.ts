import fs from 'fs';
import path from 'path';

const DOCKER_DEFAULT = '/workspace';

function detectRoot(): string {
  const env = process.env.WORKSPACE;
  if (env) return path.resolve(env);

  if (fs.existsSync(DOCKER_DEFAULT)) {
    return DOCKER_DEFAULT;
  }

  return path.resolve(process.cwd(), 'workspace');
}

export const WORKSPACE_ROOT = detectRoot();

export function resolvePath(p: string): string {
  if (!p) return p;
  if (p.startsWith(DOCKER_DEFAULT)) {
    return path.join(WORKSPACE_ROOT, p.slice(DOCKER_DEFAULT.length));
  }
  return path.resolve(WORKSPACE_ROOT, p);
}

export function resolveInWorkspace(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}

export const WORKSPACE_PATHS = {
  config: () => resolveInWorkspace('config'),
  db: () => resolveInWorkspace('db'),
  logs: () => resolveInWorkspace('logs'),
  files: () => resolveInWorkspace('files'),
  sessions: () => resolveInWorkspace('memory', 'sessions'),
  jobs: () => resolveInWorkspace('memory', 'jobs'),
  personality: () => resolveInWorkspace('memory', 'personality'),
  preferences: () => resolveInWorkspace('memory', 'personality', 'preferences.md'),
  memoryFile: () => resolveInWorkspace('memory', 'personality', 'memory.md'),
  alfredLog: () => resolveInWorkspace('logs', 'alfred.log'),
  vectors: () => resolveInWorkspace('memory', 'vectors'),
  snapshots: () => resolveInWorkspace('memory', 'snapshots'),
  healthState: () => resolveInWorkspace('memory', 'health-monitor-state.json'),
  providerBudgets: () => resolveInWorkspace('memory', 'provider-budgets.json'),
  skills: () => resolveInWorkspace('skills'),
} as const;
