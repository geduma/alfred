import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/db';
import { RetentionService } from '../../src/services/retention';

describe('RetentionService', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
    dbPath = path.join(testDir, 'test.db');
    await initializeDatabase(dbPath);
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should purge old rows per table column format and skip missing tasks table', async () => {
    const db = getDatabase();
    const sessionId = 'sess-1';
    db.prepare('INSERT INTO sessions (id, channel, user_id) VALUES (?, ?, ?)').run(sessionId, 'cli', 'u1');
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime('now', '-40 days'))")
      .run('msg-old', sessionId, 'user', 'old');
    db.prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run('msg-fresh', sessionId, 'user', 'fresh');
    db.prepare("INSERT INTO command_log (id, session_id, user_id, command, executed_at) VALUES (?, ?, ?, ?, datetime('now', '-100 days'))")
      .run('cmd-old', sessionId, 'u1', 'ls');
    db.prepare('INSERT INTO command_log (id, session_id, user_id, command) VALUES (?, ?, ?, ?)')
      .run('cmd-fresh', sessionId, 'u1', 'pwd');
    const oldIso = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO token_usage_log (date, provider, tokens_used, is_paid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('2020-01-01', 'p', 10, 0, oldIso);
    db.prepare('INSERT INTO token_usage_log (date, provider, tokens_used, is_paid, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('2099-01-01', 'p', 10, 0, new Date().toISOString());

    const svc = new RetentionService();
    const result = svc.run();

    expect(result).toEqual({ messages: 1, command_log: 1, token_usage_log: 1, tasks: 0 });
    expect((db.prepare('SELECT id FROM messages').all() as any[]).map(r => r.id)).toEqual(['msg-fresh']);
    expect((db.prepare('SELECT id FROM command_log').all() as any[]).map(r => r.id)).toEqual(['cmd-fresh']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM token_usage_log').get() as any).toMatchObject({ n: 1 });
  });

  test('should purge tasks table with epoch-ms created_at once it exists', async () => {
    const db = getDatabase();
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
    const oldMs = Date.now() - 100 * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO tasks (id, created_at) VALUES (?, ?)').run('t-old', oldMs);
    db.prepare('INSERT INTO tasks (id, created_at) VALUES (?, ?)').run('t-fresh', Date.now());

    const svc = new RetentionService({ tasks_days: 90 });
    const result = svc.run();

    expect(result.tasks).toBe(1);
    expect((db.prepare('SELECT id FROM tasks').all() as any[]).map(r => r.id)).toEqual(['t-fresh']);
  });
});
