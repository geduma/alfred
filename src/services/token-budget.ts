import { isDatabaseInitialized } from '../db';
import { TokenUsageRepository, ProviderUsageSummary } from '../db/repositories/token-usage';
import { ConfigLoader } from '../config/loader';
import { isPaidProvider, SpendingLimitsConfig } from '../types/llm';
import { getLogger } from '../utils/logger';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface TokenUsageAggregate {
  today: number;
  thisMonth: number;
  byProvider: Record<string, ProviderUsageSummary>;
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: 'daily_limit' | 'monthly_limit';
  remainingPercent: number;
  dailyRemainingPercent: number;
  monthlyRemainingPercent: number;
}

export class TokenBudgetTracker {
  private repo = new TokenUsageRepository();
  private configLoader: ConfigLoader | null;
  private dateProvider: () => Date;
  private totalInput = 0;
  private totalOutput = 0;
  private requestCount = 0;
  private warnedPeriods: Set<string> = new Set();

  constructor(configLoader?: ConfigLoader | null, dateProvider?: () => Date) {
    this.configLoader = configLoader || null;
    this.dateProvider = dateProvider || (() => new Date());
  }

  private getLimits(): SpendingLimitsConfig | null {
    const limits = this.configLoader?.llmConfig?.spending_limits;
    if (!limits || !limits.enabled) return null;
    return limits;
  }

  private getDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private getMonthStartStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }

  private getMonthStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  isPaid(providerName: string): boolean {
    const provider = this.configLoader?.providers?.[providerName];
    if (!provider) return false;
    return isPaidProvider(provider.type, provider.paid);
  }

  async trackUsage(usage: { input_tokens?: number; output_tokens?: number }, provider?: string): Promise<void> {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const total = input + output;
    this.totalInput += input;
    this.totalOutput += output;
    this.requestCount++;

    if (!provider || total <= 0) return;

    try {
      if (isDatabaseInitialized()) {
        await this.repo.insert(this.getDateStr(this.dateProvider()), provider, total, this.isPaid(provider));
      }
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Token usage persistence failed, in-memory only');
    }
  }

  async getTokenUsage(): Promise<TokenUsageAggregate> {
    const now = this.dateProvider();
    const today = this.getDateStr(now);
    const monthStart = this.getMonthStartStr(now);

    if (!isDatabaseInitialized()) {
      const total = this.getTotalUsage().total_tokens;
      return { today: total, thisMonth: total, byProvider: {} };
    }

    try {
      const [todayTokens, monthTokens, byProvider] = await Promise.all([
        this.repo.sumBetween(today, today),
        this.repo.sumBetween(monthStart, today),
        this.repo.sumByProviderBetween(monthStart, today),
      ]);
      return { today: todayTokens, thisMonth: monthTokens, byProvider };
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Token usage read failed, using in-memory totals');
      const total = this.getTotalUsage().total_tokens;
      return { today: total, thisMonth: total, byProvider: {} };
    }
  }

  async checkBudget(): Promise<BudgetCheck> {
    const limits = this.getLimits();
    if (!limits) {
      return {
        allowed: true,
        remainingPercent: 100,
        dailyRemainingPercent: 100,
        monthlyRemainingPercent: 100,
      };
    }

    const usage = await this.getTokenUsage();
    const dailyLimit = limits.daily_token_limit;
    const monthlyLimit = limits.monthly_token_limit;

    const dailyRemainingPercent = dailyLimit > 0
      ? Math.max(0, Math.min(100, ((dailyLimit - usage.today) / dailyLimit) * 100))
      : 100;
    const monthlyRemainingPercent = monthlyLimit > 0
      ? Math.max(0, Math.min(100, ((monthlyLimit - usage.thisMonth) / monthlyLimit) * 100))
      : 100;
    const remainingPercent = Math.min(dailyRemainingPercent, monthlyRemainingPercent);

    if (dailyLimit > 0 && usage.today >= dailyLimit) {
      return { allowed: false, reason: 'daily_limit', remainingPercent: 0, dailyRemainingPercent: 0, monthlyRemainingPercent };
    }
    if (monthlyLimit > 0 && usage.thisMonth >= monthlyLimit) {
      return { allowed: false, reason: 'monthly_limit', remainingPercent: 0, dailyRemainingPercent, monthlyRemainingPercent: 0 };
    }

    return { allowed: true, remainingPercent, dailyRemainingPercent, monthlyRemainingPercent };
  }

  async evaluateWarning(): Promise<'daily' | 'monthly' | null> {
    const limits = this.getLimits();
    if (!limits) return null;

    const now = this.dateProvider();
    const dailyKey = `daily:${this.getDateStr(now)}`;
    const monthlyKey = `monthly:${this.getMonthStr(now)}`;
    const usage = await this.getTokenUsage();

    const dailyLimit = limits.daily_token_limit;
    const monthlyLimit = limits.monthly_token_limit;
    const dailyUsed = dailyLimit > 0 ? usage.today / dailyLimit : 0;
    const monthlyUsed = monthlyLimit > 0 ? usage.thisMonth / monthlyLimit : 0;

    if (dailyLimit > 0 && dailyUsed >= limits.warn_threshold && !this.warnedPeriods.has(dailyKey)) {
      this.warnedPeriods.add(dailyKey);
      return 'daily';
    }
    if (monthlyLimit > 0 && monthlyUsed >= limits.warn_threshold && !this.warnedPeriods.has(monthlyKey)) {
      this.warnedPeriods.add(monthlyKey);
      return 'monthly';
    }

    return null;
  }

  getTotalUsage(): TokenUsage {
    return {
      input_tokens: this.totalInput,
      output_tokens: this.totalOutput,
      total_tokens: this.totalInput + this.totalOutput,
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.totalInput = 0;
    this.totalOutput = 0;
    this.requestCount = 0;
    this.warnedPeriods.clear();
  }
}
