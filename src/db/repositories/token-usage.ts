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
  async insert(date: string, provider: string, tokensUsed: number, isPaid: boolean): Promise<void> {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO token_usage_log (date, provider, tokens_used, is_paid, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(date, provider, tokensUsed, isPaid ? 1 : 0, new Date().toISOString());
  }

  async sumBetween(fromDate: string, toDate: string): Promise<number> {
    const db = getDatabase();
    const row = db
      .prepare('SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_usage_log WHERE date >= ? AND date <= ?')
      .get(fromDate, toDate) as { total: number } | undefined;
    return row ? Number(row.total) : 0;
  }

  async sumByProviderBetween(fromDate: string, toDate: string): Promise<Record<string, ProviderUsageSummary>> {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT provider, SUM(tokens_used) AS tokens, COUNT(*) AS requests, MAX(is_paid) AS is_paid FROM token_usage_log WHERE date >= ? AND date <= ? GROUP BY provider')
      .all(fromDate, toDate) as Array<{ provider: string; tokens: number; requests: number; is_paid: number }>;
    const summary: Record<string, ProviderUsageSummary> = {};
    for (const row of rows || []) {
      summary[row.provider] = {
        tokens: Number(row.tokens),
        requests: Number(row.requests),
        is_paid: row.is_paid === 1,
      };
    }
    return summary;
  }
}
