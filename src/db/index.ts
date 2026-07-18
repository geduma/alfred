import Database from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';

let dbInstance: Database.Database | null = null;

export function initializeDatabase(dbPath: string): Promise<Database.Database> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dbPath);
    fs.promises.mkdir(dir, { recursive: true }).catch(() => {});

    const db = new Database.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      db.run('PRAGMA foreign_keys = ON');
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA wal_autocheckpoint = 1000');

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

async function runSchema(db: Database.Database): Promise<void> {
  const schemaPath = path.resolve(__dirname, 'schema.sql');

  let schema: string;
  try {
    schema = await fs.promises.readFile(schemaPath, 'utf-8');
  } catch {
    getLogger().warn('schema.sql not found, creating tables inline');
    return;
  }

  return new Promise((resolve, reject) => {
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
