import fs from 'fs';
import path from 'path';
import { Message } from '../types/llm';
import { getLogger } from '../utils/logger';
import { WORKSPACE_PATHS } from '../utils/workspace';

const SESSIONS_DIR = WORKSPACE_PATHS.sessions();

export interface StoredSession {
  id: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  constructor() {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  get(sessionId: string): StoredSession | null {
    const filePath = this.sessionPath(sessionId);
    if (!fs.existsSync(filePath)) return null;

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error: any) {
      getLogger().warn({ sessionId, error: error.message }, 'Failed to load session, starting fresh');
      return null;
    }
  }

  getOrCreate(sessionId: string): StoredSession {
    const existing = this.get(sessionId);
    if (existing) return existing;

    const session: StoredSession = {
      id: sessionId,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return session;
  }

  save(session: StoredSession): void {
    session.updatedAt = new Date().toISOString();
    const filePath = this.sessionPath(session.id);

    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  delete(sessionId: string): void {
    const filePath = this.sessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  listActive(): StoredSession[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];

    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')) as StoredSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is StoredSession => s !== null);
  }

  private sessionPath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(SESSIONS_DIR, `${safeId}.json`);
  }
}
