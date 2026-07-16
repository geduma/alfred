import { randomUUID } from 'crypto';
import { getDatabase } from '../index';

export class MessageRepository {
  async save(sessionId: string, role: string, content: string, toolCalls?: any): Promise<string> {
    const db = getDatabase();
    const id = randomUUID();

    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO messages (id, session_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)',
        [id, sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null],
        (err) => {
          if (err) reject(err);
          else resolve(id);
        }
      );
    });
  }

  async getBySession(sessionId: string, limit: number = 50): Promise<any[]> {
    const db = getDatabase();

    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
        [sessionId, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }
}
