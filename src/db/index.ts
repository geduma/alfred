import Database from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';

let dbInstance: Database.Database | null = null;

export function initializeDatabase(dbPath: string): Promise<Database.Database> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      db.run('PRAGMA foreign_keys = ON');
      db.run('PRAGMA journal_mode = WAL');

      runSchema(db)
        .then(() => {
          dbInstance = db;
          getLogger().info({ dbPath }, 'Database initialized');
          resolve(db);
        })
        .catch(reject);
    });
  });
}

function runSchema(db: Database.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    const schemaPath = path.resolve(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      getLogger().warn('schema.sql not found, creating tables inline');
      resolve();
      return;
    }

    const schema = fs.readFileSync(schemaPath, 'utf-8');
    const statements = schema.split(';').filter(s => s.trim());

    let idx = 0;
    const runNext = () => {
      if (idx >= statements.length) {
        resolve();
        return;
      }
      const stmt = statements[idx++].trim();
      if (!stmt) {
        runNext();
        return;
      }
      db.run(stmt, (err) => {
        if (err) {
          reject(err);
          return;
        }
        runNext();
      });
    };
    runNext();
  });
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbInstance;
}
