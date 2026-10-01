import path from 'path';
import { SkillPermissions } from '../services/skill-loader';
import { WORKSPACE_ROOT } from '../utils/workspace';

const UNATTENDED_GATED_TOOLS = new Set(['exec', 'file_ops', 'web']);
const FILE_OPS_READ_ACTIONS = new Set(['read', 'list']);
const FILE_OPS_WRITE_ACTIONS = new Set(['write', 'edit', 'delete']);

export interface PolicyGate {
  strict?: boolean;
  permissions?: SkillPermissions;
  unattendedAllowlist?: Set<string>;
  noManifest?: boolean;
  skillName?: string;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

function skillSuffix(skillName?: string): string {
  return skillName ? ` for skill "${skillName}"` : '';
}

export function checkUnattendedPolicy(
  toolName: string,
  args: Record<string, unknown>,
  gate?: PolicyGate
): PolicyVerdict {
  const name = String(toolName).toLowerCase();

  if (gate?.strict && gate.permissions) {
    return checkManifestPolicy(name, args, gate.permissions, gate.skillName);
  }

  if (gate?.strict && (gate.noManifest || !gate.unattendedAllowlist)) {
    return {
      allowed: false,
      reason: `no skill manifest${skillSuffix(gate.skillName)} (strict proactive task requires approval)`,
    };
  }

  if (!UNATTENDED_GATED_TOOLS.has(name)) {
    return { allowed: true };
  }
  const allowed = gate?.unattendedAllowlist;
  if (!allowed || !allowed.has(name)) {
    return {
      allowed: false,
      reason: `"${toolName}" is not an approved action${skillSuffix(gate?.skillName)} (requires approval)`,
    };
  }
  return { allowed: true };
}

function checkManifestPolicy(
  name: string,
  args: Record<string, unknown>,
  permissions: SkillPermissions,
  skillName?: string
): PolicyVerdict {
  const tools = (permissions.tools || []).map(t => String(t).toLowerCase());
  if (!tools.includes(name)) {
    return {
      allowed: false,
      reason: `tool "${name}" is not listed in the skill manifest${skillSuffix(skillName)} (requires approval)`,
    };
  }

  if (name === 'file_ops') {
    return checkFileOpsPolicy(args, permissions, skillName);
  }
  if (name === 'web') {
    return checkWebPolicy(args, permissions, skillName);
  }
  if (name === 'exec') {
    return checkExecPolicy(args, permissions, skillName);
  }
  return { allowed: true };
}

function checkFileOpsPolicy(
  args: Record<string, unknown>,
  permissions: SkillPermissions,
  skillName?: string
): PolicyVerdict {
  const action = String(args.action || '').toLowerCase();
  const modes = (permissions.file_ops?.modes || []).map(m => String(m).toLowerCase());
  const needsWrite = FILE_OPS_WRITE_ACTIONS.has(action);
  const needsRead = FILE_OPS_READ_ACTIONS.has(action);
  if (needsWrite && !modes.includes('write')) {
    return {
      allowed: false,
      reason: `file_ops action "${action}" needs write mode${skillSuffix(skillName)} (requires approval)`,
    };
  }
  if (needsRead && !modes.includes('read') && !modes.includes('write')) {
    return {
      allowed: false,
      reason: `file_ops action "${action}" needs read mode${skillSuffix(skillName)} (requires approval)`,
    };
  }
  if (!needsWrite && !needsRead) {
    return {
      allowed: false,
      reason: `file_ops action "${action}" is unknown${skillSuffix(skillName)} (requires approval)`,
    };
  }

  const paths = permissions.file_ops?.paths || [];
  if (paths.length > 0) {
    const candidate = resolveWorkspacePath(String(args.path || ''));
    const inside = paths.some(p => {
      const allowed = resolveWorkspacePath(p);
      return candidate === allowed || candidate.startsWith(allowed + path.sep);
    });
    if (!inside) {
      return {
        allowed: false,
        reason: `file_ops path "${String(args.path || '')}" is outside the manifest paths${skillSuffix(skillName)} (requires approval)`,
      };
    }
  }
  return { allowed: true };
}

function resolveWorkspacePath(p: string): string {
  const normalized = path.normalize(p);
  const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(WORKSPACE_ROOT, normalized);
  return absolute.length > 1 ? absolute.replace(/[/\\]+$/, '') : absolute;
}

function checkWebPolicy(
  args: Record<string, unknown>,
  permissions: SkillPermissions,
  skillName?: string
): PolicyVerdict {
  if (String(args.action || '').toLowerCase() !== 'fetch') {
    return { allowed: true };
  }
  const domains = permissions.web?.domains || [];
  if (domains.includes('*')) {
    return { allowed: true };
  }
  let host = '';
  try {
    host = new URL(String(args.url || '')).hostname.toLowerCase();
  } catch {
    return {
      allowed: false,
      reason: `web fetch url is not parseable${skillSuffix(skillName)} (requires approval)`,
    };
  }
  const allowed = domains.some(d => {
    const domain = String(d).toLowerCase();
    return host === domain || (domain.startsWith('*.') && host.endsWith(domain.slice(1)));
  });
  if (!allowed) {
    return {
      allowed: false,
      reason: `web fetch domain "${host}" is not in the manifest domains${skillSuffix(skillName)} (requires approval)`,
    };
  }
  return { allowed: true };
}

function checkExecPolicy(
  args: Record<string, unknown>,
  permissions: SkillPermissions,
  skillName?: string
): PolicyVerdict {
  const allowedCommands = permissions.exec?.allowed_commands || [];
  if (allowedCommands.length === 0) {
    return {
      allowed: false,
      reason: `exec is not allowed by the skill manifest${skillSuffix(skillName)} (requires approval)`,
    };
  }
  const command = String(args.command || '').trim();
  const permitted = allowedCommands.some(entry => {
    const allowed = String(entry).trim();
    return command === allowed || command.startsWith(`${allowed} `);
  });
  if (!permitted) {
    return {
      allowed: false,
      reason: `exec command is not in the manifest allowed_commands${skillSuffix(skillName)} (requires approval)`,
    };
  }
  return { allowed: true };
}
