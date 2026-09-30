import { randomUUID } from 'crypto';
import { getDatabase } from '../index';

interface SessionRecord {
  id: string;
  channel: string;
  user_id: string;
  user_name: string | null;
  created_at: string;
  last_message_at: string | null;
  message_count: number;
  metadata: string | null;
}

export class SessionRepository {
  async getOrCreate(channel: string, userId: string, userName?: string): Promise<SessionRecord> {
    const db = getDatabase();

    const row = db
      .prepare('SELECT * FROM sessions WHERE channel = ? AND user_id = ?')
      .get(channel, userId) as SessionRecord | undefined;
    if (row) {
      return row;
    }

    const id = randomUUID();
    db.prepare('INSERT INTO sessions (id, channel, user_id, user_name) VALUES (?, ?, ?, ?)')
      .run(id, channel, userId, userName || null);
    return {
      id,
      channel,
      user_id: userId,
      user_name: userName || null,
      created_at: new Date().toISOString(),
      last_message_at: null,
      message_count: 0,
      metadata: null,
    };
  }

  async updateActivity(sessionId: string): Promise<void> {
    const db = getDatabase();
    db.prepare(
      `UPDATE sessions SET last_message_at = CURRENT_TIMESTAMP, message_count = message_count + 1 WHERE id = ?`
    ).run(sessionId);
  }
}
