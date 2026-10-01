import { getDatabase, isDatabaseInitialized } from '../db/index';
import { RetentionConfig } from '../types/config';
import { getLogger } from '../utils/logger';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  messages: number;
  command_log: number;
  token_usage_log: number;
  tasks: number;
}

export class RetentionService {
  private config: RetentionConfig;

  constructor(config?: Partial<RetentionConfig>) {
    this.config = {
      tasks_days: 90,
      messages_days: 30,
      command_log_days: 90,
      token_usage_log_days: 400,
      ...config,
    };
  }

  updateConfig(config: Partial<RetentionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  run(): RetentionResult {
    const result: RetentionResult = { messages: 0, command_log: 0, token_usage_log: 0, tasks: 0 };
    if (!isDatabaseInitialized()) return result;

    const db = getDatabase();
    result.messages = this.purgeBySqliteDatetime('messages', 'created_at', this.config.messages_days);
    result.command_log = this.purgeBySqliteDatetime('command_log', 'executed_at', this.config.command_log_days);
    result.token_usage_log = this.purgeByIsoText('token_usage_log', 'created_at', this.config.token_usage_log_days);
    result.tasks = this.purgeByEpochMs('tasks', 'created_at', this.config.tasks_days);

    try {
      db.exec('PRAGMA incremental_vacuum');
    } catch (error: any) {
      getLogger().debug({ error: error.message }, 'incremental_vacuum skipped');
    }

    const total = result.messages + result.command_log + result.token_usage_log + result.tasks;
    if (total > 0) {
      getLogger().info({ ...result }, 'Retention purge completed');
    }
    return result;
  }

  private tableExists(table: string): boolean {
    const db = getDatabase();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    return !!row;
  }

  private purgeBySqliteDatetime(table: string, column: string, days: number): number {
    if (!this.tableExists(table)) return 0;
    try {
      const res = getDatabase().prepare(
        `DELETE FROM ${table} WHERE ${column} < datetime('now', ?)`
      ).run(`-${Math.floor(days)} days`);
      return Number(res.changes) || 0;
    } catch (error: any) {
      getLogger().debug({ table, error: error.message }, 'Retention purge skipped for table');
      return 0;
    }
  }

  private purgeByIsoText(table: string, column: string, days: number): number {
    if (!this.tableExists(table)) return 0;
    try {
      const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();
      const res = getDatabase().prepare(
        `DELETE FROM ${table} WHERE ${column} < ?`
      ).run(cutoff);
      return Number(res.changes) || 0;
    } catch (error: any) {
      getLogger().debug({ table, error: error.message }, 'Retention purge skipped for table');
      return 0;
    }
  }

  private purgeByEpochMs(table: string, column: string, days: number): number {
    if (!this.tableExists(table)) return 0;
    try {
      const cutoff = Date.now() - days * MS_PER_DAY;
      const res = getDatabase().prepare(
        `DELETE FROM ${table} WHERE ${column} < ?`
      ).run(cutoff);
      return Number(res.changes) || 0;
    } catch (error: any) {
      getLogger().debug({ table, error: error.message }, 'Retention purge skipped for table');
      return 0;
    }
  }
}
