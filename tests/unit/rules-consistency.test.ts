import fs from 'fs';
import path from 'path';

const RULES = fs.readFileSync(path.resolve(__dirname, '../../system/alfred-rules.md'), 'utf-8');

function section(title: string): string {
  const start = RULES.indexOf(title);
  if (start === -1) throw new Error(`section missing: ${title}`);
  const end = RULES.indexOf('---', start);
  return RULES.slice(start, end === -1 ? undefined : end);
}

describe('alfred-rules consistency', () => {
  test('preferences protocol names the single canonical store', () => {
    const prefs = section('## Preferences Protocol');
    expect(prefs).toContain('{workspace}/memory/personality/preferences.md');
    expect(prefs).toContain('user_name');
    expect(prefs).toMatch(/anywhere else|only .*preferences\.md/i);
  });

  test('shared memory redirects identity to preferences.md, never claims it', () => {
    const shared = section('## Shared Memory Protocol');
    expect(shared).toContain('preferences.md');
    expect(shared).not.toMatch(/persist[^.]*\b(identity|user_name)\b[^.]*memory\.md/i);
    expect(shared).not.toMatch(/save[^.]*\b(name|identity)\b[^.]*memory\.md/i);
  });
});
