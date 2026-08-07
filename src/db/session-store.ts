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

export class SessionStore {
  private ready: Promise<void>;

  constructor() {
    this.ready = fs.promises.mkdir(SESSIONS_DIR, { recursive: true }).then(() => {}).catch(() => {});
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
    session.updatedAt = new Date().toISOString();
    const filePath = this.sessionPath(session.id);
    await fs.promises.writeFile(filePath, JSON.stringify(session), 'utf-8');
  }

  private sessionPath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(SESSIONS_DIR, `${safeId}.json`);
  }
}