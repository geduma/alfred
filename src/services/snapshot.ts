import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { StoredSession } from '../db/session-store';
import { WORKSPACE_PATHS } from '../utils/workspace';
import { getLogger } from '../utils/logger';
import { SnapshotConfig } from '../types/config';

const SNAPSHOTS_DIR = path.join(WORKSPACE_PATHS.sessions(), '..', 'snapshots');

export interface Snapshot {
  id: string;
  sessionId: string;
  timestamp: string;
  messageCount: number;
  summary: string;
  tags: string[];
}

export interface SnapshotStore {
  get(snapshotId: string): Promise<Snapshot | null>;
  list(sessionId: string): Promise<Snapshot[]>;
  save(snapshot: Snapshot): Promise<void>;
  delete(snapshotId: string): Promise<void>;
}

class FileSnapshotStore implements SnapshotStore {
  private ready: Promise<void>;

  constructor() {
    this.ready = fs.promises.mkdir(SNAPSHOTS_DIR, { recursive: true }).then(() => {}).catch(() => {});
  }

  private async ensureDir(): Promise<void> {
    await this.ready;
  }

  async get(snapshotId: string): Promise<Snapshot | null> {
    await this.ensureDir();
    const filePath = this.filePath(snapshotId);
    try {
      await fs.promises.access(filePath);
    } catch {
      return null;
    }
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  async list(sessionId: string): Promise<Snapshot[]> {
    await this.ensureDir();

    let files: string[];
    try {
      files = await fs.promises.readdir(SNAPSHOTS_DIR);
    } catch {
      return [];
    }

    const results = await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          try {
            return JSON.parse(await fs.promises.readFile(path.join(SNAPSHOTS_DIR, f), 'utf-8')) as Snapshot;
          } catch {
            return null;
          }
        })
    );

    return results
      .filter((s): s is Snapshot => s !== null && s.sessionId === sessionId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async save(snapshot: Snapshot): Promise<void> {
    await this.ensureDir();
    await fs.promises.writeFile(this.filePath(snapshot.id), JSON.stringify(snapshot), 'utf-8');
  }

  async delete(snapshotId: string): Promise<void> {
    await this.ensureDir();
    try {
      await fs.promises.unlink(this.filePath(snapshotId));
    } catch { /* not found */ }
  }

  private filePath(snapshotId: string): string {
    return path.join(SNAPSHOTS_DIR, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }
}

export class SnapshotManager {
  private config: SnapshotConfig;
  private store: FileSnapshotStore;
  private messageCounters: Map<string, number> = new Map();

  constructor(config: SnapshotConfig) {
    this.config = config;
    this.store = new FileSnapshotStore();
  }

  async create(session: StoredSession, tags?: string[]): Promise<Snapshot> {
    const summary = session.summary || `Session with ${session.messages.length} messages`;

    const snapshot: Snapshot = {
      id: `snap_${Date.now()}_${randomUUID().slice(0, 8)}`,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      messageCount: session.messages.length,
      summary,
      tags: tags || [],
    };

    await this.store.save(snapshot);
    await this.enforceLimit(session.id);

    getLogger().info(
      { snapshotId: snapshot.id, sessionId: session.id, messageCount: snapshot.messageCount },
      'Snapshot created'
    );

    return snapshot;
  }

  shouldAutoSnapshot(sessionId: string, currentMessageCount: number): boolean {
    if (!this.config.enabled || this.config.auto_snapshot_interval <= 0) return false;

    const lastCount = this.messageCounters.get(sessionId) || 0;
    if (currentMessageCount - lastCount >= this.config.auto_snapshot_interval) {
      this.messageCounters.set(sessionId, currentMessageCount);
      return true;
    }

    return false;
  }

  cleanupCounters(activeSessionIds: Set<string>): void {
    for (const sessionId of this.messageCounters.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.messageCounters.delete(sessionId);
      }
    }
  }

  async listBySession(sessionId: string): Promise<Snapshot[]> {
    return this.store.list(sessionId);
  }

  async get(snapshotId: string): Promise<Snapshot | null> {
    return this.store.get(snapshotId);
  }

  async delete(snapshotId: string): Promise<void> {
    await this.store.delete(snapshotId);
  }

  async restore(session: StoredSession, snapshotId: string): Promise<StoredSession> {
    const snapshot = await this.store.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

    const snapshots = await this.store.list(session.id);
    const targetSnapshot = snapshots.find(s => s.id === snapshotId);
    if (!targetSnapshot) throw new Error(`Snapshot ${snapshotId} not found for session ${session.id}`);

    session.summary = targetSnapshot.summary;
    getLogger().info({ snapshotId, sessionId: session.id }, 'Session restored from snapshot');
    return session;
  }

  private async enforceLimit(sessionId: string): Promise<void> {
    const max = this.config.max_snapshots_per_session || 20;
    const existing = await this.store.list(sessionId);

    if (existing.length > max) {
      const toDelete = existing.slice(max);
      await Promise.all(toDelete.map(snap => this.store.delete(snap.id)));
      getLogger().info({ sessionId, deleted: toDelete.length }, 'Old snapshots pruned');
    }
  }
}