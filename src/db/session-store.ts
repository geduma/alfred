import fs from 'fs';
import path from 'path';
import { Message } from '../types/llm';
import { getLogger } from '../utils/logger';
import { WORKSPACE_PATHS } from '../utils/workspace';

const SESSIONS_DIR = WORKSPACE_PATHS.sessions();

export interface StoredSession {
  id: string;
  messages: Message[];
  summary?: string;
  summarySections?: {
    decisions: string[];
    preferences: string[];
    pending: string[];
    context: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SessionStoreOptions {
  maxVerbatimMessages?: number;
  retentionDays?: number;
  sessionsDir?: string;
}

export class SessionStore {
  private ready: Promise<void>;
  private maxVerbatimMessages: number;
  private retentionDays: number;
  private sessionsDir: string;

  constructor(options: SessionStoreOptions = {}) {
    this.maxVerbatimMessages = options.maxVerbatimMessages ?? 20;
    this.retentionDays = options.retentionDays ?? 30;
    this.sessionsDir = options.sessionsDir || SESSIONS_DIR;
    this.ready = fs.promises.mkdir(this.sessionsDir, { recursive: true }).then(() => {}).catch(() => {});
  }

  private async ensureDir(): Promise<void> {
    await this.ready;
  }

  async get(sessionId: string): Promise<StoredSession | null> {
    await this.ensureDir();
    const filePath = this.sessionPath(sessionId);

    try {
      await fs.promises.access(filePath);
    } catch {
      return null;
    }

    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    } catch (error: any) {
      getLogger().warn({ sessionId, error: error.message }, 'Failed to load session, starting fresh');
      return null;
    }
  }

  async getOrCreate(sessionId: string): Promise<StoredSession> {
    const existing = await this.get(sessionId);
    if (existing) return existing;

    const session: StoredSession = {
      id: sessionId,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return session;
  }

  async save(session: StoredSession): Promise<void> {
    await this.ensureDir();
    this.pruneSession(session);
    session.updatedAt = new Date().toISOString();
    const filePath = this.sessionPath(session.id);
    await fs.promises.writeFile(filePath, JSON.stringify(session), 'utf-8');
  }

  private pruneSession(session: StoredSession): void {
    if (!session.summary || session.messages.length <= this.maxVerbatimMessages) return;

    const summaryMsg: Message = {
      role: 'user',
      content: `[COMPRESSED CONTEXT - Summary of earlier conversation]\n${session.summary}`,
    };

    session.messages = [summaryMsg, ...session.messages.slice(-this.maxVerbatimMessages)];
    getLogger().debug(
      { sessionId: session.id, kept: session.messages.length },
      'Session history pruned on save'
    );
  }

  async purgeExpired(): Promise<number> {
    await this.ensureDir();
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    try {
      const files = await fs.promises.readdir(this.sessionsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.sessionsDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.promises.unlink(filePath);
            removed++;
          }
        } catch {
          // ignore per-file failures
        }
      }
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Session purge failed');
    }

    if (removed > 0) {
      getLogger().info({ removed, retentionDays: this.retentionDays }, 'Purged expired session files');
    }
    return removed;
  }

  private sessionPath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }
}
