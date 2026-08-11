import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillLoader } from '../../src/services/skill-loader';

describe('SkillLoader', () => {
  let testDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
    loader = new SkillLoader(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    loader.stopWatching();
  });

  test('should return empty when directory missing', async () => {
    const emptyLoader = new SkillLoader('/nonexistent/path');
    const skills = await emptyLoader.loadSkills();
    expect(skills).toEqual([]);
  });

  test('should load skills from directory', async () => {
    const skillContent = `# Test Skill\n> A test skill description\nTools: exec, web\n\n---\nUse this skill to test things\nAlways verify results\n`;
    fs.writeFileSync(path.join(testDir, 'test-skill.md'), skillContent, 'utf-8');

    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Test Skill');
    expect(skills[0].description).toBe('A test skill description');
    expect(skills[0].tools).toEqual(['exec', 'web']);
    expect(skills[0].instructions).toContain('Use this skill to test things');
  });

  test('should skip files without title', async () => {
    fs.writeFileSync(path.join(testDir, 'no-title.md'), 'Just some content', 'utf-8');
    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(0);
  });

  test('should generate context string without full instructions', () => {
    const skillsContext = loader.getSkillsContext([
      { name: 'Test', description: 'A test', tools: ['exec', 'web'], instructions: 'Do the thing', filePath: 'test.md' },
    ]);
    expect(skillsContext).toContain('### Test');
    expect(skillsContext).toContain('A test');
    expect(skillsContext).toContain('Requires tools: exec, web');
    expect(skillsContext).not.toContain('Do the thing');
  });

  test('should return empty for no skills', () => {
    expect(loader.getSkillsContext([])).toBe('');
  });

  test('should invalidate cache', async () => {
    const skillContent = `# Test\n\n---\ninstructions\n`;
    fs.writeFileSync(path.join(testDir, 'skill.md'), skillContent, 'utf-8');

    await loader.loadSkills();
    loader.invalidateCache();
    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(1);
  });

  test('should load skills from system/web/files subdirs', async () => {
    fs.mkdirSync(path.join(testDir, 'system'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'web'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'files'), { recursive: true });

    fs.writeFileSync(path.join(testDir, 'system', 'sys-skill.md'), '# Sys Skill\n> A system skill\n\n---\nRun it for system tasks\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'web', 'web-skill.md'), '# Web Skill\n> A web skill\n\n---\nRun it for web tasks\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'files', 'file-skill.md'), '# File Skill\n> A files skill\n\n---\nRun it for file tasks\n', 'utf-8');

    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(3);

    const names = skills.map(s => s.name);
    expect(names).toContain('Sys Skill');
    expect(names).toContain('Web Skill');
    expect(names).toContain('File Skill');

    const sysSkill = skills.find(s => s.name === 'Sys Skill');
    expect(sysSkill?.filePath).toBe(path.join('system', 'sys-skill.md'));
  });

  test('should dedup skills by name with precedence custom > root > system > web > files', async () => {
    fs.mkdirSync(path.join(testDir, 'custom'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'system'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'web'), { recursive: true });

    const content = (desc: string) => `# Dupe\n> ${desc}\n\n---\nInstructions\n`;

    fs.writeFileSync(path.join(testDir, 'custom', 'dupe.md'), content('custom version'), 'utf-8');
    fs.writeFileSync(path.join(testDir, 'system', 'dupe.md'), content('system version'), 'utf-8');
    fs.writeFileSync(path.join(testDir, 'web', 'dupe.md'), content('web version'), 'utf-8');

    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('custom version');
    expect(skills[0].filePath).toBe(path.join('custom', 'dupe.md'));
  });

  test('should dedup root vs system with root taking precedence', async () => {
    fs.mkdirSync(path.join(testDir, 'system'), { recursive: true });

    fs.writeFileSync(path.join(testDir, 'dupe.md'), '# Root\n> root version\n\n---\nInstructions\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'system', 'dupe.md'), '# Root\n> system version\n\n---\nInstructions\n', 'utf-8');

    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('root version');
  });

  test('should pick up a new skill in a subdir after cache invalidation', async () => {
    fs.mkdirSync(path.join(testDir, 'system'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'existing.md'), '# Existing\n\n---\ninstructions\n', 'utf-8');

    await loader.loadSkills();
    expect(await loader.loadSkills()).toHaveLength(1);

    fs.writeFileSync(path.join(testDir, 'system', 'added.md'), '# Added Later\n\n---\ninstructions\n', 'utf-8');
    loader.invalidateCache();

    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.name)).toContain('Added Later');
  });

  test('should tolerate empty subdirs', async () => {
    fs.mkdirSync(path.join(testDir, 'system'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'web'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'files'), { recursive: true });

    const skills = await loader.loadSkills();
    expect(skills).toEqual([]);
  });
});