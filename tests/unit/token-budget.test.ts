import { TokenBudgetTracker } from '../../src/services/token-budget';

describe('TokenBudgetTracker', () => {
  let tracker: TokenBudgetTracker;

  beforeEach(() => {
    tracker = new TokenBudgetTracker({
      max_input_tokens_per_request: 1000,
      max_output_tokens_per_request: 500,
      max_context_tokens: 2000,
      warn_threshold: 0.8,
    });
  });

  test('should allow within limits', () => {
    const result = tracker.checkRequest(500, 200);
    expect(result.allowed).toBe(true);
  });

  test('should deny excessive input', () => {
    const result = tracker.checkRequest(2000, 200);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Input exceeds max');
  });

  test('should deny excessive output', () => {
    const result = tracker.checkRequest(500, 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Output exceeds max');
  });

  test('should require compaction above threshold', () => {
    const result = tracker.checkContext(1800);
    expect(result.allowed).toBe(true);
    expect(result.shouldCompact).toBe(true);
  });

  test('should deny context above max', () => {
    const result = tracker.checkContext(2500);
    expect(result.allowed).toBe(false);
    expect(result.shouldCompact).toBe(true);
  });

  test('should not compact below threshold', () => {
    const result = tracker.checkContext(1000);
    expect(result.allowed).toBe(true);
    expect(result.shouldCompact).toBe(false);
  });

  test('should track session usage', () => {
    tracker.trackUsage('session1', { input_tokens: 100, output_tokens: 50 });
    tracker.trackUsage('session1', { input_tokens: 200, output_tokens: 100 });

    const usage = tracker.getSessionUsage('session1');
    expect(usage.input_tokens).toBe(300);
    expect(usage.output_tokens).toBe(150);
    expect(usage.total_tokens).toBe(450);
  });

  test('should reset session', () => {
    tracker.trackUsage('session1', { input_tokens: 100, output_tokens: 50 });
    tracker.resetSession('session1');
    const usage = tracker.getSessionUsage('session1');
    expect(usage.total_tokens).toBe(0);
  });
});