import { getDatabase } from '../index';

export interface TokenUsageRow {
  id: number;
  date: string;
  provider: string;
  tokens_used: number;
  is_paid: number;
  created_at: string;
}

export interface ProviderUsageSummary {
  tokens: number;
  requests: number;
  is_paid: boolean;
}

export class TokenUsageRepository {
  insert(date: string, provider: string, tokensUsed: number, isPaid: boolean): Promise<void> {
    const db = getDatabase();
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO token_usage_log (date, provider, tokens_used, is_paid, created_at) VALUES (?, ?, ?, ?, ?)',
        [date, provider, tokensUsed, isPaid ? 1 : 0, new Date().toISOString()],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  sumBetween(fromDate: string, toDate: string): Promise<number> {
    const db = getDatabase();
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_usage_log WHERE date >= ? AND date <= ?',
        [fromDate, toDate],
        (err, row: { total: number } | undefined) => {
          if (err) reject(err);
          else resolve(row ? Number(row.total) : 0);
        }
      );
    });
  }

  sumByProviderBetween(fromDate: string, toDate: string): Promise<Record<string, ProviderUsageSummary>> {
    const db = getDatabase();
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT provider, SUM(tokens_used) AS tokens, COUNT(*) AS requests, MAX(is_paid) AS is_paid FROM token_usage_log WHERE date >= ? AND date <= ? GROUP BY provider',
        [fromDate, toDate],
        (err, rows: Array<{ provider: string; tokens: number; requests: number; is_paid: number }> | undefined) => {
          if (err) reject(err);
          else {
            const summary: Record<string, ProviderUsageSummary> = {};
            for (const row of rows || []) {
              summary[row.provider] = {
                tokens: Number(row.tokens),
                requests: Number(row.requests),
                is_paid: row.is_paid === 1,
              };
            }
            resolve(summary);
          }
        }
      );
    });
  }
}
