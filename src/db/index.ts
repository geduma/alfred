import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';
import { SCHEMA_SQL } from './schema';

let dbInstance: Database.Database | null = null;

export async function initializeDatabase(dbPath: string): Promise<Database.Database> {
  const dir = path.dirname(dbPath);
  await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('auto_vacuum = INCREMENTAL');

  runSchema(db);
  dbInstance = db;
  getLogger().info({ dbPath }, 'Database initialized');
  return db;
}

function runSchema(db: Database.Database): void {
  let schema = SCHEMA_SQL;

  const schemaPath = path.resolve(__dirname, 'schema.sql');
  try {
    schema = fs.readFileSync(schemaPath, 'utf-8');
  } catch {
    getLogger().debug('schema.sql not found, using embedded schema');
  }

  db.exec(schema);
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbInstance;
}

export function isDatabaseInitialized(): boolean {
  return dbInstance !== null;
}

export async function closeDatabase(): Promise<void> {
  const db = dbInstance;
  dbInstance = null;
  if (!db) {
    return;
  }
  try {
    db.close();
    getLogger().info('Database closed');
  } catch (err: any) {
    getLogger().warn({ error: err.message }, 'Failed to close database cleanly');
  }
}
