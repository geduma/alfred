import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillLoader } from '../../src/services/skill-loader';

describe('Skill trigger frontmatter', () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  });

  test('should parse a nested condition trigger block', async () => {
    fs.writeFileSync(
      path.join(skillsDir, 'ssl.md'),
      `---\nname: ssl-cert-check\nunattended: true\ntrigger:\n  type: condition\n  check_tool: exec\n  check_command: openssl s_client -connect example.com:443\n  notify_if: days_remaining < 14\n  cooldown_hours: 12\n---\n\nCheck the cert.\n`
    );
    const loader = new SkillLoader(skillsDir);
    const [skill] = await loader.loadSkills();

    expect(skill.trigger).toEqual({
      type: 'condition',
      check_tool: 'exec',
      check_command: 'openssl s_client -connect example.com:443',
      notify_if: 'days_remaining < 14',
      cooldown_hours: 12,
    });
  });

  test('should parse a schedule trigger and ignore skills without trigger', async () => {
    fs.writeFileSync(
      path.join(skillsDir, 'digest.md'),
      `---\nname: daily-digest\nunattended: true\ntrigger:\n  type: schedule\n  cron: "0 8 * * *"\n---\n\nDigest.\n`
    );
    fs.writeFileSync(path.join(skillsDir, 'plain.md'), `# Plain\n\nNo frontmatter trigger here.\n`);
    const loader = new SkillLoader(skillsDir);
    const skills = await loader.loadSkills();

    expect(skills.find(s => s.name === 'daily-digest')?.trigger).toEqual({ type: 'schedule', cron: '0 8 * * *' });
    expect(skills.find(s => s.name === 'Plain')?.trigger).toBeUndefined();
  });

  test('should reject unknown trigger types', async () => {
    fs.writeFileSync(
      path.join(skillsDir, 'odd.md'),
      `---\nname: odd\ntrigger:\n  type: webhook\n---\n\nOdd.\n`
    );
    const loader = new SkillLoader(skillsDir);
    const [skill] = await loader.loadSkills();

    expect(skill.trigger).toBeUndefined();
  });
});
