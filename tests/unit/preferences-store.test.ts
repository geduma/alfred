import fs from 'fs';
import os from 'os';
import path from 'path';

describe('preferences-store', () => {
  let tmp: string;
  let store: typeof import('../../src/services/preferences-store');
  const OLD_WORKSPACE = process.env.WORKSPACE;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-store-'));
    if (process.env.WORKSPACE === undefined) delete process.env.WORKSPACE;
    process.env.WORKSPACE = tmp;
    jest.isolateModules(() => {
      store = require('../../src/services/preferences-store');
    });
  });

  afterEach(() => {
    if (OLD_WORKSPACE === undefined) delete process.env.WORKSPACE;
    else process.env.WORKSPACE = OLD_WORKSPACE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('should create the file with header on first write', () => {
    store.writePreference('user_name', 'Geduma');
    const raw = fs.readFileSync(path.join(tmp, 'memory', 'personality', 'preferences.md'), 'utf-8');
    expect(raw).toContain('## Dynamic Preferences');
    expect(raw).toContain('user_name: Geduma');
    expect(store.readPreferences().user_name).toBe('Geduma');
  });

  test('should update one key and keep the others intact', () => {
    store.writePreference('language', 'english');
    store.writePreference('user_name', 'Geduma');
    store.writePreference('language', 'spanish');
    const prefs = store.readPreferences();
    expect(prefs).toMatchObject({ language: 'spanish', user_name: 'Geduma' });
  });

  test('should reject unknown keys', () => {
    expect(() => store.writePreference('hack_the_planet', 'yes')).toThrow(/Unknown preference key/);
  });

  test('should read an agent-written file without the web header', () => {
    const file = path.join(tmp, 'memory', 'personality', 'preferences.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'user_name: Ana\nlanguage: spanish\n', 'utf-8');
    store.writePreference('tone', 'casual');
    const prefs = store.readPreferences();
    expect(prefs).toMatchObject({ user_name: 'Ana', language: 'spanish', tone: 'casual' });
  });
});
