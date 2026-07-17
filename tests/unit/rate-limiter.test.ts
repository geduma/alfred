import { RateLimiter } from '../../src/security/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(false);
  });

  afterEach(() => {
    limiter.stop();
  });

  test('should allow first request', () => {
    expect(limiter.isAllowed('test', 5, 60)).toBe(true);
  });

  test('should block after limit exceeded', () => {
    for (let i = 0; i < 3; i++) {
      limiter.isAllowed('block_test', 3, 60);
    }
    expect(limiter.isAllowed('block_test', 3, 60)).toBe(false);
  });

  test('should allow after reset', () => {
    for (let i = 0; i < 2; i++) {
      limiter.isAllowed('reset_test', 2, 60);
    }
    expect(limiter.isAllowed('reset_test', 2, 60)).toBe(false);
    limiter.reset('reset_test');
    expect(limiter.isAllowed('reset_test', 2, 60)).toBe(true);
  });

  test('should track usage', () => {
    limiter.isAllowed('usage_test', 10, 60);
    limiter.isAllowed('usage_test', 10, 60);
    expect(limiter.getUsage('usage_test')).toBe(2);
  });

  test('should handle user checks', () => {
    expect(limiter.checkUser('user1', 100)).toBe(true);
  });

  test('should handle channel checks', () => {
    expect(limiter.checkChannel('telegram', 1000)).toBe(true);
  });
});
