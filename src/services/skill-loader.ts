import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger';
import { isDatabaseInitialized, getDatabase } from '../db';

const SUPPORTED_SUBDIRS = ['system', 'web', 'files'];

export interface SkillTrigger {
  type: 'schedule' | 'condition';
  cron?: string;
  check_tool?: string;
  check_command?: string;
  notify_if?: string;
  cooldown_hours?: number;
}

export interface SkillPermissions {
  tools?: string[];
  file_ops?: { paths?: string[]; modes?: string[] };
  web?: { domains?: string[] };
  exec?: { allowed_commands?: string[] };
  requires_secrets?: string[];
}

export interface Skill {
  name: string;
  description: string;
  tools?: string[];
  unattended?: boolean;
  approvedActions?: string[];
  permissions?: SkillPermissions;
  trigger?: SkillTrigger;
  instructions: string;
  filePath: string;
}

export class SkillLoader {
  private skillsDir: string;
  private cachedSkills: Skill[] | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  startWatching(intervalMs = 30_000): void {
    this.cachedSkills = null;
    this.watchTimer = setInterval(() => {
      this.cachedSkills = null;
    }, intervalMs);
  }

  stopWatching(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  async loadSkills(): Promise<Skill[]> {
    if (this.cachedSkills) return this.cachedSkills;

    try {
      await fs.promises.access(this.skillsDir);
    } catch {
      this.cachedSkills = [];
      return [];
    }

    const skills: Skill[] = [];
    const seen = new Set<string>();

    const scanDir = async (dir: string, dirName: string | null): Promise<void> => {
      let files: string[];
      try {
        files = await fs.promises.readdir(dir);
      } catch {
        return;
      }

      for (const file of files.filter(f => f.endsWith('.md'))) {
        const relative = dirName ? path.join(dirName, file) : file;
        const fullPath = path.join(dir, file);
        try {
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          const skill = this.parseSkill(content, relative);
          if (!skill) continue;
          const key = skill.name.trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          skills.push(skill);
        } catch (error: any) {
          getLogger().warn({ file: relative, error: error.message }, 'Failed to load skill');
        }
      }
    };

    await scanDir(path.join(this.skillsDir, 'custom'), 'custom');
    await scanDir(this.skillsDir, null);
    for (const sub of SUPPORTED_SUBDIRS) {
      await scanDir(path.join(this.skillsDir, sub), sub);
    }

    this.cachedSkills = skills;
    this.cacheSkillsInDb(skills, this.skillsDir);
    getLogger().info({ count: skills.length, dir: this.skillsDir }, 'Skills loaded');
    return skills;
  }

  getSkillsContext(skills: Skill[]): string {
    if (skills.length === 0) return '';

    return skills.map(s => {
      let block = `### ${s.name}\n${s.description || 'No description'}`;
      if (s.tools && s.tools.length > 0) {
        block += `\nRequires tools: ${s.tools.join(', ')}`;
      }
      return block;
    }).join('\n\n---\n\n');
  }

  async resolveJobSkill(message: string): Promise<Skill | null> {
    const skills = await this.loadSkills();
    const normalized = (message || '').toLowerCase();
    if (!normalized.trim()) return null;

    for (const skill of skills) {
      const name = skill.name.toLowerCase().trim();
      if (name && normalized.includes(name)) {
        return skill;
      }
    }
    return null;
  }

  invalidateCache(): void {
    this.cachedSkills = null;
  }

  private parseSkill(content: string, fileName: string): Skill | null {
    const frontmatter = this.parseFrontmatter(content);
    const name = frontmatter?.name || content.match(/^#\s+(.+)$/m)?.[1];
    const description = frontmatter?.description || content.match(/^>\s*(.+)$/m)?.[1];
    const tools = frontmatter?.tools
      ? String(frontmatter.tools).split(',').map(t => t.trim())
      : content.match(/^Tools:\s*(.+)$/m)?.[1]?.split(',').map(t => t.trim());
    const unattended = this.parseUnattendedFlag(frontmatter?.unattended);
    const approvedActions = frontmatter?.approved_actions
      ? String(frontmatter.approved_actions).split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
      : undefined;
    const trigger = this.parseTrigger(content, frontmatter);

    if (!name) {
      getLogger().warn({ file: fileName }, 'Skill file missing title (# heading), skipping');
      return null;
    }

    const instructions = this.extractInstructions(content, frontmatter !== null);

    if (!instructions) return null;

    return {
      name: name.trim(),
      description: description ? description.trim() : '',
      tools,
      unattended,
      approvedActions: approvedActions && approvedActions.length > 0 ? approvedActions : undefined,
      permissions: this.parsePermissions(content),
      trigger,
      instructions,
      filePath: fileName,
    };
  }

  private parseUnattendedFlag(value?: string): boolean | undefined {
    if (value === undefined || value === '') return undefined;
    return ['true', 'yes', '1'].includes(String(value).trim().toLowerCase());
  }

  private parseTrigger(content: string, frontmatter: Record<string, string> | null): SkillTrigger | undefined {
    const nested = this.parseTriggerBlock(content);
    const flat = frontmatter || {};
    const type = (nested.type || flat.trigger_type || '').trim();
    if (type !== 'schedule' && type !== 'condition') return undefined;

    if (type === 'schedule') {
      return { type, cron: nested.cron || flat.trigger_cron || undefined };
    }

    const cooldown = Number(nested.cooldown_hours || flat.trigger_cooldown_hours || '');
    return {
      type,
      check_tool: nested.check_tool || flat.trigger_check_tool || undefined,
      check_command: nested.check_command || flat.trigger_check_command || undefined,
      notify_if: nested.notify_if || flat.trigger_notify_if || undefined,
      cooldown_hours: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : undefined,
    };
  }

  private parsePermissions(content: string): SkillPermissions | undefined {
    if (!content.startsWith('---\n')) return undefined;
    const end = content.indexOf('\n---\n', 4);
    if (end < 0) return undefined;
    const lines = content.slice(4, end).split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^permissions:\s*$/.test(lines[i])) {
        start = i;
        break;
      }
    }
    if (start < 0) return undefined;

    const perms: SkillPermissions = {};
    let section: string | null = null;
    let sectionIndent = 0;
    let found = false;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\S/.test(line)) break;
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(indent, idx).trim();
      const rawValue = line.slice(idx + 1).trim();
      if (!key) continue;
      if (section === null || indent <= sectionIndent) {
        if (rawValue) {
          this.assignPermissionList(perms, key, rawValue);
          found = true;
        } else {
          section = key;
          sectionIndent = indent;
        }
        continue;
      }
      if (section && rawValue) {
        this.assignPermissionSubkey(perms, section, key, rawValue);
        found = true;
      }
    }
    return found ? perms : undefined;
  }

  private splitPermissionList(value: string): string[] {
    const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
    return inner.split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  private assignPermissionList(perms: SkillPermissions, key: string, rawValue: string): void {
    const list = this.splitPermissionList(rawValue);
    if (key === 'tools') perms.tools = list;
    else if (key === 'requires_secrets') perms.requires_secrets = list;
  }

  private assignPermissionSubkey(perms: SkillPermissions, section: string, key: string, rawValue: string): void {
    const list = this.splitPermissionList(rawValue);
    if (section === 'file_ops' && (key === 'paths' || key === 'modes')) {
      perms.file_ops = perms.file_ops || {};
      perms.file_ops[key] = list;
    } else if (section === 'web' && key === 'domains') {
      perms.web = perms.web || {};
      perms.web.domains = list;
    } else if (section === 'exec' && key === 'allowed_commands') {
      perms.exec = perms.exec || {};
      perms.exec.allowed_commands = list;
    }
  }

  private parseTriggerBlock(content: string): Record<string, string> {
    if (!content.startsWith('---\n')) return {};
    const end = content.indexOf('\n---\n', 4);
    if (end < 0) return {};
    const lines = content.slice(4, end).split('\n');
    const nested: Record<string, string> = {};
    let inside = false;
    for (const line of lines) {
      if (!inside) {
        if (/^trigger:\s*$/.test(line)) inside = true;
        continue;
      }
      if (/^\S/.test(line)) break;
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key) nested[key] = value;
      }
    }
    return nested;
  }

  private parseFrontmatter(content: string): Record<string, string> | null {
    if (!content.startsWith('---\n')) return null;
    const end = content.indexOf('\n---\n', 4);
    if (end < 0) return null;

    const block = content.slice(4, end);
    const fields: Record<string, string> = {};

    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key) fields[key] = value;
      }
    }

    return Object.keys(fields).length > 0 ? fields : null;
  }

  private extractInstructions(content: string, hasFrontmatter: boolean): string {
    if (hasFrontmatter) {
      const end = content.indexOf('\n---\n', 4);
      return content.slice(end + 5).trim();
    }

    const instructionsStart = content.indexOf('\n---\n');
    if (instructionsStart >= 0) {
      return content.slice(instructionsStart + 5).trim();
    }

    return content
      .replace(/^#\s+.+\n/, '')
      .replace(/^>.+\n/, '')
      .replace(/^Tools:.+\n/, '')
      .trim();
  }

  private async cacheSkillsInDb(skills: Skill[], dir: string): Promise<void> {
    if (!isDatabaseInitialized()) return;

    const db = getDatabase();
    const now = new Date().toISOString();

    for (const skill of skills) {
      try {
        const fullPath = path.join(dir, skill.filePath);
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');

        db.prepare(
          `INSERT INTO skills_cache (name, description, file_path, enabled, last_loaded, hash)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             file_path = excluded.file_path,
             enabled = 1,
             last_loaded = excluded.last_loaded,
             hash = excluded.hash`
        ).run(skill.name, skill.description || '', fullPath, now, hash);
      } catch (error: any) {
        getLogger().debug({ skill: skill.name, error: error.message }, 'Failed to cache skill in DB');
      }
    }
  }
}
