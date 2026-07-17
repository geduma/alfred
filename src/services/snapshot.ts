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
  get(snapshotId: string): Snapshot | null;
  list(sessionId: string): Snapshot[];
  save(snapshot: Snapshot): void;
  delete(snapshotId: string): void;
}

class FileSnapshotStore implements SnapshotStore {
  constructor() {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
  }

  get(snapshotId: string): Snapshot | null {
    const filePath = this.filePath(snapshotId);
    if (!fs.existsSync(filePath)) return null;

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  list(sessionId: string): Snapshot[] {
    if (!fs.existsSync(SNAPSHOTS_DIR)) return [];

    return fs.readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const snap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf-8')) as Snapshot;
          return snap.sessionId === sessionId ? snap : null;
        } catch {
          return null;
        }
      })
      .filter((s): s is Snapshot => s !== null)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  save(snapshot: Snapshot): void {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
    fs.writeFileSync(this.filePath(snapshot.id), JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  delete(snapshotId: string): void {
    const filePath = this.filePath(snapshotId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private filePath(snapshotId: string): string {
    return path.join(SNAPSHOTS_DIR, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }
}

export class SnapshotManager {
  private config: SnapshotConfig;
  private store: SnapshotStore;
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

    this.store.save(snapshot);
    this.enforceLimit(session.id);

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

  listBySession(sessionId: string): Snapshot[] {
    return this.store.list(sessionId);
  }

  get(snapshotId: string): Snapshot | null {
    return this.store.get(snapshotId);
  }

  delete(snapshotId: string): void {
    this.store.delete(snapshotId);
  }

  private enforceLimit(sessionId: string): void {
    const max = this.config.max_snapshots_per_session || 20;
    const existing = this.store.list(sessionId);

    if (existing.length > max) {
      const toDelete = existing.slice(max);
      for (const snap of toDelete) {
        this.store.delete(snap.id);
      }
      getLogger().info({ sessionId, deleted: toDelete.length }, 'Old snapshots pruned');
    }
  }
}
