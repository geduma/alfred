import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/db/index';
import { TokenUsageRepository } from '../../src/db/repositories/token-usage';

const OLD_SCHEMA = `
CREATE TABLE token_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  tokens_used INTEGER NOT NULL,
  is_paid INTEGER NOT NULL,
  created_at TEXT NOT NULL
);`;

describe('token_usage_log source column', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-src-'));
  });

  afterEach(async () => {
    await closeDatabase().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('fresh databases include the source column', async () => {
    await initializeDatabase(path.join(tmp, 'fresh.db'));
    const cols = getDatabase().prepare('PRAGMA table_info(token_usage_log)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('source');
  });

  test('legacy databases gain the source column via migration', async () => {
    const dbPath = path.join(tmp, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(OLD_SCHEMA);
    legacy.prepare(
      'INSERT INTO token_usage_log (date, provider, tokens_used, is_paid, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('2026-09-30', 'test-provider', 5000, 1, '2026-09-30T00:00:00Z');
    legacy.close();

    await initializeDatabase(dbPath);

    const repo = new TokenUsageRepository();
    await repo.insert('2026-10-01', 'test-provider', 3000, true, 'fast_probe');
    await repo.insert('2026-10-01', 'test-provider', 2000, true, 'compaction');
    await expect(repo.sumBySourceBetween('2026-09-01', '2026-10-01')).resolves.toEqual({
      interactive: 5000,
      fast_probe: 3000,
      compaction: 2000,
    });
  });
});
