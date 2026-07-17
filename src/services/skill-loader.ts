import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';

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
    const nameMatch = content.match(/^#\s+(.+)$/m);
    const descMatch = content.match(/^>\s*(.+)$/m);
    const toolsMatch = content.match(/^Tools:\s*(.+)$/m);

    if (!nameMatch) {
      getLogger().warn({ file: fileName }, 'Skill file missing title (# heading), skipping');
      return null;
    }

    const instructionsStart = content.indexOf('\n---\n');
    const instructions = instructionsStart >= 0
      ? content.slice(instructionsStart + 5).trim()
      : content.replace(/^#\s+.+\n/, '').replace(/^>.+\n/, '').replace(/^Tools:.+\n/, '').trim();

    if (!instructions) return null;

    return {
      name: nameMatch[1].trim(),
      description: descMatch ? descMatch[1].trim() : '',
      tools: toolsMatch ? toolsMatch[1].split(',').map(t => t.trim()) : undefined,
      instructions,
      filePath: fileName,
    };
  }
}