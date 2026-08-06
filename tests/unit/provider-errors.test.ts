import {
  isThrottleError,
  parseRequestedTokens,
  nextContextBudget,
  MIN_CONTEXT_BUDGET,
} from '../../src/utils/provider-errors';

describe('provider-errors', () => {
  describe('isThrottleError', () => {
    test('detects HTTP 429', () => {
      expect(isThrottleError('HTTP 429 Too Many Requests')).toBe(true);
    });

    test('detects HTTP 413 request too large', () => {
      expect(isThrottleError('API request failed: 413 Request Entity Too Large')).toBe(true);
    });

    test('detects raw 429 numeric status', () => {
      expect(isThrottleError('429')).toBe(true);
    });

    test('detects rate limit wording', () => {
      expect(isThrottleError('You are being rate limited. Please retry.')).toBe(true);
    });

    test('detects request too large wording', () => {
      expect(isThrottleError('Request too large for model')).toBe(true);
    });

    test('detects context window exceeded wording', () => {
      expect(isThrottleError('This model context window is 8000 tokens')).toBe(true);
    });

    test('detects token limit wording', () => {
      expect(isThrottleError('tokens_per_minute limit reached')).toBe(true);
    });

    test('rejects unrelated errors', () => {
      expect(isThrottleError('Connection refused')).toBe(false);
      expect(isThrottleError('Invalid API key')).toBe(false);
      expect(isThrottleError('')).toBe(false);
      expect(isThrottleError(undefined as unknown as string)).toBe(false);
    });
  });

  describe('parseRequestedTokens', () => {
    test('extracts the requested token count', () => {
      expect(parseRequestedTokens('Requested 8328 tokens, exceeding the model context limit')).toBe(8328);
    });

    test('returns null when no count is present', () => {
      expect(parseRequestedTokens('Request too large')).toBeNull();
    });

    test('returns null for unknown messages', () => {
      expect(parseRequestedTokens('HTTP 429')).toBeNull();
    });
  });

  describe('nextContextBudget', () => {
    test('shrinks by 30% when no requested count is available', () => {
      expect(nextContextBudget(32000, undefined)).toBe(22400);
    });

    test('stays at least 15% below the requested size', () => {
      expect(nextContextBudget(32000, 8328)).toBe(7078);
    });

    test('prefers the 30% shrink when it is smaller', () => {
      expect(nextContextBudget(32000, 40000)).toBe(22400);
    });

    test('floors at the minimum context budget', () => {
      expect(nextContextBudget(MIN_CONTEXT_BUDGET, undefined)).toBe(MIN_CONTEXT_BUDGET);
      expect(nextContextBudget(3000, 1000)).toBe(MIN_CONTEXT_BUDGET);
    });
  });
});
