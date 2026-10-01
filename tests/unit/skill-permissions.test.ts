import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillLoader } from '../../src/services/skill-loader';

describe('Skill permissions frontmatter', () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-perms-'));
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  test('should parse a nested structured manifest', async () => {
    fs.writeFileSync(
      path.join(skillsDir, 'a.md'),
      '---\nname: Struct\nunattended: true\npermissions:\n  tools: [web, file_ops]\n  file_ops:\n    paths: [/workspace/files/digest/]\n    modes: [read, write]\n  web:\n    domains: ["*"]\n  exec:\n    allowed_commands: []\n  requires_secrets: []\n---\n\nBody.\n'
    );
    const loader = new SkillLoader(skillsDir);
    const [skill] = await loader.loadSkills();

    expect(skill.permissions).toEqual({
      tools: ['web', 'file_ops'],
      file_ops: { paths: ['/workspace/files/digest/'], modes: ['read', 'write'] },
      web: { domains: ['*'] },
      exec: { allowed_commands: [] },
      requires_secrets: [],
    });
  });

  test('should accept comma-separated values without brackets', async () => {
    fs.writeFileSync(
      path.join(skillsDir, 'b.md'),
      '---\nname: Comma\nunattended: true\npermissions:\n  tools: exec, health\n---\n\nBody.\n'
    );
    const loader = new SkillLoader(skillsDir);
    const [skill] = await loader.loadSkills();

    expect(skill.permissions).toEqual({ tools: ['exec', 'health'] });
  });

  test('should leave permissions undefined without a block and keep legacy working', async () => {
    fs.writeFileSync(
      path.join(skillsDir, 'c.md'),
      '---\nname: Legacy\nunattended: true\napproved_actions: exec\n---\n\nBody.\n'
    );
    const loader = new SkillLoader(skillsDir);
    const [skill] = await loader.loadSkills();

    expect(skill.permissions).toBeUndefined();
    expect(skill.approvedActions).toEqual(['exec']);
  });
});

describe('Bundled skills manifests', () => {
  test('should declare structured manifests for the migrated skills', async () => {
    const loader = new SkillLoader(path.resolve(__dirname, '../../system/skills-custom'));
    const skills = await loader.loadSkills();
    for (const name of ['Daily Digest', 'System Check', 'Weekly Review']) {
      const skill = skills.find(s => s.name === name);
      expect(skill?.unattended).toBe(true);
      expect(skill?.permissions?.tools?.length).toBeGreaterThan(0);
      expect(skill?.approvedActions).toBeUndefined();
    }
    const digest = skills.find(s => s.name === 'Daily Digest');
    expect(digest?.permissions?.exec?.allowed_commands).toContain('cat');
    const review = skills.find(s => s.name === 'Weekly Review');
    expect(review?.permissions?.file_ops?.modes).toContain('write');
  });
});
