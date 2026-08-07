import { TokenBudgetTracker } from '../../src/services/token-budget';

describe('TokenBudgetTracker', () => {
  let tracker: TokenBudgetTracker;

  beforeEach(() => {
    tracker = new TokenBudgetTracker();
  });

  test('should start at zero', () => {
    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
    expect(tracker.getRequestCount()).toBe(0);
  });

  test('should track usage', () => {
    tracker.trackUsage({ input_tokens: 100, output_tokens: 50 });
    tracker.trackUsage({ input_tokens: 200, output_tokens: 100 });

    const usage = tracker.getTotalUsage();
    expect(usage.input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(150);
    expect(usage.total_tokens).toBe(450);
    expect(tracker.getRequestCount()).toBe(2);
  });

  test('should handle empty usage', () => {
    tracker.trackUsage({});

    const usage = tracker.getTotalUsage();
    expect(usage.total_tokens).toBe(0);
    expect(tracker.getRequestCount()).toBe(1);
  });

  test('should reset', () => {
    tracker.trackUsage({ input_tokens: 100, output_tokens: 50 });
    tracker.reset();

    const usage = tracker.getTotalUsage();
    expect(usage.total_tokens).toBe(0);
    expect(tracker.getRequestCount()).toBe(0);
  });
});
