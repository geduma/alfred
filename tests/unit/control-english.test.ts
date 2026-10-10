import fs from 'fs';
import path from 'path';
import { isControlMessage, resolveConductorMessage } from '../../src/agent/conductor-messages';
import { getDisplay, getDisplayLanguage, isDisplayControlMessage, clearDisplayCache } from '../../src/services/display-strings';

let mockLang = 'en';
jest.mock('../../src/services/preferences-store', () => {
  const actual = jest.requireActual('../../src/services/preferences-store');
  return { ...actual, readPreferences: () => ({ language: mockLang }) };
});

const SRC_DIR = path.resolve(__dirname, '../../src');
const SPANISH_LITERALS = ['En seguida', 'Enseguida', 'Le aviso'];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('english-only control messages', () => {
  beforeEach(() => {
    clearDisplayCache();
  });

  test('no Spanish literals in src', () => {
    const files = collectTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const literal of SPANISH_LITERALS) {
        if (content.includes(literal)) offenders.push(`${path.relative(SRC_DIR, file)}: ${literal}`);
      }
      if (/señor/i.test(content)) offenders.push(`${path.relative(SRC_DIR, file)}: señor`);
    }
    expect(offenders).toEqual([]);
  });

  test('canonical messages are English', () => {
    mockLang = 'en';
    expect(resolveConductorMessage('ack.enqueued')).toBe('Right away, sir...');
    expect(isControlMessage('Right away, sir...')).toBe(true);
    expect(isControlMessage('Right away, sir... (2)')).toBe(true);
  });

  test('display layer localizes without code dictionary', () => {
    mockLang = 'es';
    clearDisplayCache();
    expect(getDisplayLanguage()).toBe('es');
    expect(getDisplay('ack.enqueued')).toBe('En seguida, señor...');
    expect(isDisplayControlMessage('En seguida, señor...')).toBe(true);
    mockLang = 'en';
    clearDisplayCache();
    expect(getDisplay('ack.enqueued')).toBe('Right away, sir...');
  });
});
