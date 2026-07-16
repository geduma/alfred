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

    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM sessions WHERE channel = ? AND user_id = ?',
        [channel, userId],
        (err, row: SessionRecord | undefined) => {
          if (err) { reject(err); return; }
          if (row) {
            resolve(row);
          } else {
            const id = randomUUID();
            db.run(
              'INSERT INTO sessions (id, channel, user_id, user_name) VALUES (?, ?, ?, ?)',
              [id, channel, userId, userName || null],
              (err2) => {
                if (err2) { reject(err2); return; }
                resolve({
                  id,
                  channel,
                  user_id: userId,
                  user_name: userName || null,
                  created_at: new Date().toISOString(),
                  last_message_at: null,
                  message_count: 0,
                  metadata: null,
                });
              }
            );
          }
        }
      );
    });
  }

  async updateActivity(sessionId: string): Promise<void> {
    const db = getDatabase();
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE sessions SET last_message_at = CURRENT_TIMESTAMP, message_count = message_count + 1 WHERE id = ?`,
        [sessionId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
}
