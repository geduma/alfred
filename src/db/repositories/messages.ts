import { randomUUID } from 'crypto';
import { getDatabase } from '../index';

export class MessageRepository {
  async save(sessionId: string, role: string, content: string, toolCalls?: any): Promise<string> {
    const db = getDatabase();
    const id = randomUUID();

    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null);
    return id;
  }

  async getBySession(sessionId: string, limit: number = 50): Promise<any[]> {
    const db = getDatabase();

    return db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(sessionId, limit) as any[];
  }
}
