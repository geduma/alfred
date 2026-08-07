import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase, isDatabaseInitialized, getDatabase } from '../../src/db';
import { SessionRepository } from '../../src/db/repositories/sessions';
import { MessageRepository } from '../../src/db/repositories/messages';
import { CommandRepository } from '../../src/db/repositories/commands';

describe('SQLite repositories', () => {
  let testDir: string;
  let dbPath: string;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    dbPath = path.join(testDir, 'test.db');
    await initializeDatabase(dbPath);
  });

  afterAll(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should be initialized', () => {
    expect(isDatabaseInitialized()).toBe(true);
    expect(getDatabase()).toBeDefined();
  });

  test('should create and reuse sessions', async () => {
    const repo = new SessionRepository();
    const first = await repo.getOrCreate('telegram', 'user-1', 'Alice');
    expect(first.id).toBeDefined();
    expect(first.channel).toBe('telegram');
    expect(first.user_id).toBe('user-1');

    const again = await repo.getOrCreate('telegram', 'user-1', 'Alice');
    expect(again.id).toBe(first.id);
  });

  test('should track session activity', async () => {
    const repo = new SessionRepository();
    const session = await repo.getOrCreate('telegram', 'user-2');
    await repo.updateActivity(session.id);
    await repo.updateActivity(session.id);
    expect(session.message_count).toBe(0);
  });

  test('should save and retrieve messages with tool_calls', async () => {
    const sessionRepo = new SessionRepository();
    const messageRepo = new MessageRepository();
    const session = await sessionRepo.getOrCreate('cli', 'user-3');

    await messageRepo.save(session.id, 'user', 'hello');
    await messageRepo.save(session.id, 'assistant', '', [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{}' } }]);
    await messageRepo.save(session.id, 'tool', 'result', undefined);

    const messages = await messageRepo.getBySession(session.id);
    expect(messages).toHaveLength(3);
    expect(messages[1].tool_calls).toContain('"name":"exec"');
    expect(messages[0].content).toBe('hello');
  });

  test('should log commands for a user', async () => {
    const sessionRepo = new SessionRepository();
    const commandRepo = new CommandRepository();
    const session = await sessionRepo.getOrCreate('cli', 'user-4');

    await commandRepo.log({ sessionId: session.id, userId: 'user-4', command: 'ls -la', result: 'ok', exitCode: 0, durationMs: 42 });
    await commandRepo.log({ sessionId: session.id, userId: 'user-4', command: 'ls -la', result: 'error', exitCode: 2, durationMs: 10 });

    const logs = await commandRepo.getByUser('user-4');
    expect(logs).toHaveLength(2);
    expect(logs.map(l => l.exit_code).sort()).toEqual([0, 2]);
    expect(logs.map(l => l.command)).toEqual(['ls -la', 'ls -la']);
  });
});
