import { randomUUID } from 'crypto';
import { getDatabase } from '../index';
import { NewTask, Task } from '../../types/task';

function toTask(row: any): Task {
  return {
    id: row.id,
    origin_channel: row.origin_channel,
    origin_chat_id: row.origin_chat_id ?? null,
    session_id: row.session_id ?? null,
    kind: row.kind,
    skill_name: row.skill_name ?? null,
    input: row.input,
    status: row.status,
    result: row.result ?? null,
    error_detail: row.error_detail ?? null,
    attempts: Number(row.attempts) || 0,
    max_attempts: Number(row.max_attempts) || 1,
    created_at: Number(row.created_at),
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    notified_at: row.notified_at ?? null,
  };
}

export class TaskRepository {
  async create(input: NewTask): Promise<Task> {
    const db = getDatabase();
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, origin_channel, origin_chat_id, session_id, kind, skill_name, input, status, attempts, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
    ).run(
      id,
      input.origin_channel,
      input.origin_chat_id ?? null,
      input.session_id ?? null,
      input.kind,
      input.skill_name ?? null,
      input.input,
      input.max_attempts ?? 1,
      now
    );
    return this.getById(id) as Promise<Task>;
  }

  async getById(id: string): Promise<Task | null> {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? toTask(row) : null;
  }

  claimNext(): Task | null {
    const db = getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db
        .prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
        .get() as any;
      if (!row) {
        db.exec('ROLLBACK');
        return null;
      }
      const now = Date.now();
      db.prepare('UPDATE tasks SET status = ?, started_at = ?, attempts = attempts + 1 WHERE id = ?')
        .run('running', now, row.id);
      db.exec('COMMIT');
      return toTask({ ...row, status: 'running', started_at: now, attempts: Number(row.attempts) + 1 });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // rollback best-effort
      }
      throw error;
    }
  }

  async markDone(id: string, result: string): Promise<void> {
    const db = getDatabase();
    db.prepare('UPDATE tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run('done', result, Date.now(), id);
  }

  async markFailed(id: string, result: string, errorDetail?: string): Promise<void> {
    const db = getDatabase();
    db.prepare('UPDATE tasks SET status = ?, result = ?, error_detail = ?, finished_at = ? WHERE id = ?')
      .run('failed', result, errorDetail ?? null, Date.now(), id);
  }

  async markNeedsApproval(id: string, result: string): Promise<void> {
    const db = getDatabase();
    db.prepare('UPDATE tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run('needs_approval', result, Date.now(), id);
  }

  async releaseForRetry(id: string): Promise<void> {
    const db = getDatabase();
    db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL WHERE id = ?").run(id);
  }

  async getUnnotified(limit: number = 20): Promise<Task[]> {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT * FROM tasks WHERE status IN ('done', 'failed', 'needs_approval') AND notified_at IS NULL ORDER BY finished_at ASC LIMIT ?")
      .all(limit) as any[];
    return rows.map(toTask);
  }

  async getStaleUnnotifiedFailures(graceMs: number): Promise<Task[]> {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT * FROM tasks WHERE status = 'failed' AND notified_at IS NULL AND finished_at < ? ORDER BY finished_at ASC LIMIT 20")
      .all(Date.now() - graceMs) as any[];
    return rows.map(toTask);
  }

  async markNotified(id: string): Promise<void> {
    const db = getDatabase();
    db.prepare('UPDATE tasks SET notified_at = ? WHERE id = ?').run(Date.now(), id);
  }

  async reapOrphaned(): Promise<number> {
    const db = getDatabase();
    const res = db
      .prepare("UPDATE tasks SET status = 'failed', error_detail = 'orphaned_on_restart', finished_at = ? WHERE status = 'running'")
      .run(Date.now());
    return Number(res.changes) || 0;
  }

  async countByStatus(status: string): Promise<number> {
    const db = getDatabase();
    const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get(status) as any;
    return Number(row?.n) || 0;
  }
}
