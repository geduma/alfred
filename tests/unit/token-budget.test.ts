import { TokenBudgetTracker } from '../../src/services/token-budget';
import { TokenUsageRepository } from '../../src/db/repositories/token-usage';

jest.mock('../../src/db', () => ({ isDatabaseInitialized: () => true }));
jest.mock('../../src/db/repositories/token-usage', () => ({
  TokenUsageRepository: jest.fn().mockImplementation(() => ({
    insert: jest.fn().mockResolvedValue(undefined),
    sumBetween: jest.fn().mockResolvedValue(0),
    sumByProviderBetween: jest.fn().mockResolvedValue({}),
  })),
}));

const MockRepo = TokenUsageRepository as jest.MockedClass<typeof TokenUsageRepository>;

function getRepo(tracker: any): any {
  return tracker.repo;
}

function makeConfig(spendingLimits?: any, providers?: any): any {
  return {
    llmConfig: { spending_limits: spendingLimits },
    providers: providers || {
      anthropic: { type: 'anthropic' },
      ollama: { type: 'openai-compatible' },
      paidOpenAI: { type: 'openai-compatible', paid: true },
    },
  };
}

function fixedDate(iso: string): () => Date {
  return () => new Date(iso);
}

describe('TokenBudgetTracker', () => {
  test('should start at zero', () => {
    const tracker = new TokenBudgetTracker();
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
    expect(tracker.getRequestCount()).toBe(0);
  });

  test('should track usage in memory', () => {
    const tracker = new TokenBudgetTracker();
    tracker.trackUsage({ input_tokens: 100, output_tokens: 50 });
    tracker.trackUsage({ input_tokens: 200, output_tokens: 100 });

    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(150);
    expect(usage.total_tokens).toBe(450);
    expect(tracker.getRequestCount()).toBe(2);
  });

  test('should handle empty usage', () => {
    const tracker = new TokenBudgetTracker();
    tracker.trackUsage({});
    expect(tracker.getTotalUsage().total_tokens).toBe(0);
    expect(tracker.getRequestCount()).toBe(1);
  });

  test('should reset', () => {
    const tracker = new TokenBudgetTracker();
    tracker.trackUsage({ input_tokens: 100, output_tokens: 50 });
    tracker.reset();
    expect(tracker.getTotalUsage().total_tokens).toBe(0);
    expect(tracker.getRequestCount()).toBe(0);
  });

  test('should persist usage to the repository when a provider is given', async () => {
    const tracker = new TokenBudgetTracker(makeConfig(), fixedDate('2026-08-08T12:00:00Z'));
    await tracker.trackUsage({ input_tokens: 100, output_tokens: 50 }, 'anthropic');
    expect(getRepo(tracker).insert).toHaveBeenCalledWith('2026-08-08', 'anthropic', 150, true);
  });

  test('isPaid: anthropic defaults to paid, openai-compatible defaults to free', () => {
    const tracker = new TokenBudgetTracker(makeConfig());
    expect(tracker.isPaid('anthropic')).toBe(true);
    expect(tracker.isPaid('ollama')).toBe(false);
    expect(tracker.isPaid('paidOpenAI')).toBe(true);
    expect(tracker.isPaid('unknown')).toBe(false);
  });

  test('checkBudget: no spending limits → always allowed at 100%', async () => {
    const tracker = new TokenBudgetTracker(makeConfig());
    const budget = await tracker.checkBudget();
    expect(budget.allowed).toBe(true);
    expect(budget.remainingPercent).toBe(100);
    expect(budget.dailyRemainingPercent).toBe(100);
    expect(budget.monthlyRemainingPercent).toBe(100);
  });

  test('checkBudget: usage within limits → allowed with correct remaining percent', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValueOnce(300).mockResolvedValueOnce(3000);
    const budget = await tracker.checkBudget();
    expect(budget.allowed).toBe(true);
    expect(budget.dailyRemainingPercent).toBe(70);
    expect(budget.monthlyRemainingPercent).toBe(70);
    expect(budget.remainingPercent).toBe(70);
  });

  test('checkBudget: daily limit reached → blocked with daily_limit reason', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_all' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValueOnce(1000).mockResolvedValueOnce(3000);
    const budget = await tracker.checkBudget();
    expect(budget.allowed).toBe(false);
    expect(budget.reason).toBe('daily_limit');
    expect(budget.dailyRemainingPercent).toBe(0);
  });

  test('checkBudget: monthly limit reached → blocked with monthly_limit reason', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_all' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValueOnce(100).mockResolvedValueOnce(12000);
    const budget = await tracker.checkBudget();
    expect(budget.allowed).toBe(false);
    expect(budget.reason).toBe('monthly_limit');
    expect(budget.monthlyRemainingPercent).toBe(0);
  });

  test('checkBudget: disabled limits → always allowed', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: false, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_all' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValueOnce(9999).mockResolvedValueOnce(99999);
    const budget = await tracker.checkBudget();
    expect(budget.allowed).toBe(true);
  });

  test('evaluateWarning: fires daily warning once per day, then dedupes', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValue(800); // 80% of 1000
    expect(await tracker.evaluateWarning()).toBe('daily');
    expect(await tracker.evaluateWarning()).toBeNull();
  });

  test('evaluateWarning: no warning below threshold', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValue(100);
    expect(await tracker.evaluateWarning()).toBeNull();
  });

  test('evaluateWarning: fires monthly warning when only monthly limit is crossed', async () => {
    const tracker = new TokenBudgetTracker(
      makeConfig({ enabled: true, daily_token_limit: 1000, monthly_token_limit: 10000, warn_threshold: 0.8, on_limit_reached: 'block_paid_providers' }),
      fixedDate('2026-08-08T12:00:00Z')
    );
    const repo = getRepo(tracker);
    repo.sumBetween.mockResolvedValueOnce(100).mockResolvedValueOnce(9500); // 95% of 10000
    expect(await tracker.evaluateWarning()).toBe('monthly');
  });
});
