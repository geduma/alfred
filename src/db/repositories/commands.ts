import { randomUUID } from 'crypto';
import { getDatabase } from '../index';

interface CommandLogRecord {
  id: string;
  session_id: string;
  user_id: string;
  command: string;
  result: string | null;
  exit_code: number | null;
  executed_at: string;
  duration_ms: number | null;
}

export class CommandRepository {
  async log(params: {
    sessionId: string;
    userId: string;
    command: string;
    result?: string;
    exitCode?: number;
    durationMs?: number;
  }): Promise<string> {
    const db = getDatabase();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO command_log (id, session_id, user_id, command, result, exit_code, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, params.sessionId, params.userId, params.command, params.result || null, params.exitCode ?? null, params.durationMs ?? null);
    return id;
  }

  async getByUser(userId: string, limit: number = 20): Promise<CommandLogRecord[]> {
    const db = getDatabase();

    return db
      .prepare('SELECT * FROM command_log WHERE user_id = ? ORDER BY executed_at DESC LIMIT ?')
      .all(userId, limit) as CommandLogRecord[];
  }
}
