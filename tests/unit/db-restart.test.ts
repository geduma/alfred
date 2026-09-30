import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/db';
import { SessionRepository } from '../../src/db/repositories/sessions';

describe('SQLite restart smoke', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restart-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should survive write, close and reopen', async () => {
    await initializeDatabase(dbPath);
    const sessions = new SessionRepository();
    const created = await sessions.getOrCreate('cli', 'restart-user');
    await closeDatabase();

    await initializeDatabase(dbPath);
    const sessions2 = new SessionRepository();
    const reopened = await sessions2.getOrCreate('cli', 'restart-user');
    expect(reopened.id).toBe(created.id);
    expect(getDatabase().pragma('journal_mode', { simple: true })).toBe('wal');
  });
});
