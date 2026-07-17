import { CircuitBreaker } from '../../src/services/circuit-breaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5000, cooldownPeriodMs: 1000 });
  });

  test('should allow first requests', () => {
    expect(cb.isAllowed('provider1')).toBe(true);
    expect(cb.isAllowed('provider2')).toBe(true);
  });

  test('should open after threshold failures', () => {
    cb.recordFailure('p1');
    expect(cb.isAllowed('p1')).toBe(true);
    cb.recordFailure('p1');
    expect(cb.isAllowed('p1')).toBe(false);
  });

  test('should reset on success', () => {
    cb.recordFailure('p1');
    cb.recordSuccess('p1');
    expect(cb.isAllowed('p1')).toBe(true);
  });

  test('should report state correctly', () => {
    cb.recordFailure('p1');
    let state = cb.getState('p1');
    expect(state.open).toBe(false);
    expect(state.failures).toBe(1);

    cb.recordFailure('p1');
    state = cb.getState('p1');
    expect(state.open).toBe(true);
    expect(state.failures).toBe(2);
  });

  test('should allow half-open after reset timeout', () => {
    cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
    cb.recordFailure('p1');
    expect(cb.isAllowed('p1')).toBe(true);
  });
});