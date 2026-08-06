import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getLogger } from '../utils/logger';
import { isDatabaseInitialized, getDatabase } from '../db';

export interface Skill {
  name: string;
  description: string;
  tools?: string[];
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

    let files: string[];
    try {
      files = await fs.promises.readdir(this.skillsDir);
    } catch {
      this.cachedSkills = [];
      return [];
    }

    const skillFiles = files.filter(f => f.endsWith('.md'));
    const skills: Skill[] = [];

    for (const file of skillFiles) {
      try {
        const content = await fs.promises.readFile(path.join(this.skillsDir, file), 'utf-8');
        const skill = this.parseSkill(content, file);
        if (skill) skills.push(skill);
      } catch (error: any) {
        getLogger().warn({ file, error: error.message }, 'Failed to load skill');
      }
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
      block += `\n\n${s.instructions}`;
      return block;
    }).join('\n\n---\n\n');
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
      instructions,
      filePath: fileName,
    };
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

        await new Promise<void>((resolve, reject) => {
          db.run(
            `INSERT INTO skills_cache (name, description, file_path, enabled, last_loaded, hash)
             VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               description = excluded.description,
               file_path = excluded.file_path,
               enabled = 1,
               last_loaded = excluded.last_loaded,
               hash = excluded.hash`,
            [skill.name, skill.description || '', fullPath, now, hash],
            (err) => err ? reject(err) : resolve()
          );
        });
      } catch (error: any) {
        getLogger().debug({ skill: skill.name, error: error.message }, 'Failed to cache skill in DB');
      }
    }
  }
}
