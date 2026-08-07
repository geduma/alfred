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

  test('should generate context string', () => {
    const skillsContext = loader.getSkillsContext([
      { name: 'Test', description: 'A test', instructions: 'Do the thing', filePath: 'test.md' },
    ]);
    expect(skillsContext).toContain('### Test');
    expect(skillsContext).toContain('A test');
    expect(skillsContext).toContain('Do the thing');
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
});