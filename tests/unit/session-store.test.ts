import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionStore, StoredSession } from '../../src/db/session-store';
import { Message } from '../../src/types/llm';

function makeSession(id: string, count: number, summary?: string): StoredSession {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: `message ${i}` });
  }
  return {
    id,
    messages,
    ...(summary ? { summary } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('SessionStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('should prune session history to summary + last N verbatim when summary exists', async () => {
    const store = new SessionStore({ sessionsDir: dir, maxVerbatimMessages: 10 });
    const session = makeSession('prune-test', 50, 'KEY_FACTS: name is Felipe');

    await store.save(session);
    const loaded = await store.get('prune-test');

    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(11);
    expect(loaded!.messages[0].content).toContain('[COMPRESSED CONTEXT - Summary of earlier conversation]');
    expect(loaded!.messages[0].content).toContain('name is Felipe');
    expect(loaded!.messages[loaded!.messages.length - 1].content).toBe('message 49');
    expect(loaded!.summary).toBe('KEY_FACTS: name is Felipe');
  });

  test('should not prune when no summary is available', async () => {
    const store = new SessionStore({ sessionsDir: dir, maxVerbatimMessages: 10 });
    const session = makeSession('no-summary', 50);

    await store.save(session);
    const loaded = await store.get('no-summary');

    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(50);
  });

  test('should not prune when message count is within the verbatim limit', async () => {
    const store = new SessionStore({ sessionsDir: dir, maxVerbatimMessages: 50 });
    const session = makeSession('within-limit', 20, 'summary');

    await store.save(session);
    const loaded = await store.get('within-limit');

    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(20);
  });

  test('should purge session files older than the retention window', async () => {
    const store = new SessionStore({ sessionsDir: dir, retentionDays: 1 });

    const oldId = 'old-session';
    const freshId = 'fresh-session';
    await store.save(makeSession(oldId, 3));
    await store.save(makeSession(freshId, 3));

    const oldPath = path.join(dir, `${oldId}.json`);
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await fs.promises.utimes(oldPath, oldTime, oldTime);

    const removed = await store.purgeExpired();

    expect(removed).toBe(1);
    await expect(fs.promises.access(oldPath)).rejects.toThrow();
    await expect(fs.promises.access(path.join(dir, `${freshId}.json`))).resolves.toBeUndefined();
  });

  test('should ignore non-session files during purge', async () => {
    const store = new SessionStore({ sessionsDir: dir, retentionDays: 1 });
    await fs.promises.writeFile(path.join(dir, 'keep.txt'), 'x');

    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.promises.utimes(path.join(dir, 'keep.txt'), oldTime, oldTime);

    const removed = await store.purgeExpired();
    expect(removed).toBe(0);
    await expect(fs.promises.access(path.join(dir, 'keep.txt'))).resolves.toBeUndefined();
  });
});
