import {
  isThrottleError,
  isRetryableError,
  getErrorStatus,
  getErrorMessage,
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

  describe('getErrorStatus', () => {
    test('extracts numeric status from error object', () => {
      expect(getErrorStatus({ status: 413, message: 'too large' })).toBe(413);
    });

    test('extracts string status from error object', () => {
      expect(getErrorStatus({ status: '502', message: 'bad gateway' })).toBe(502);
    });

    test('extracts status embedded in message', () => {
      expect(getErrorStatus(new Error('Provider error: (status 413)'))).toBe(413);
      expect(getErrorStatus('HTTP 500 Internal Server Error')).toBe(500);
    });

    test('returns null for errors without a status', () => {
      expect(getErrorStatus(new Error('Connection refused'))).toBeNull();
      expect(getErrorStatus(null)).toBeNull();
    });
  });

  describe('getErrorMessage', () => {
    test('returns message from Error instances', () => {
      expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    test('returns strings as-is', () => {
      expect(getErrorMessage('raw')).toBe('raw');
    });

    test('handles arbitrary objects', () => {
      expect(getErrorMessage({ code: 'E1' })).toBe('{"code":"E1"}');
      expect(getErrorMessage(undefined)).toBe('');
    });
  });

  describe('isRetryableError', () => {
    test('retries 5xx and transient statuses', () => {
      expect(isRetryableError({ status: 500 })).toBe(true);
      expect(isRetryableError({ status: 502 })).toBe(true);
      expect(isRetryableError({ status: 503 })).toBe(true);
      expect(isRetryableError({ status: 504 })).toBe(true);
      expect(isRetryableError({ status: 408 })).toBe(true);
      expect(isRetryableError({ status: 409 })).toBe(true);
    });

    test('retries throttling statuses', () => {
      expect(isRetryableError({ status: 429 })).toBe(true);
      expect(isRetryableError({ status: 413 })).toBe(true);
      expect(isRetryableError(new Error('Request too large (status 413)'))).toBe(true);
      expect(isRetryableError('You are being rate limited. Please retry.')).toBe(true);
    });

    test('retries network and timeout errors', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('socket hang up'))).toBe(true);
      expect(isRetryableError({ message: 'Request timed out' })).toBe(true);
    });

    test('does not retry client errors or missing statuses', () => {
      expect(isRetryableError({ status: 400 })).toBe(false);
      expect(isRetryableError({ status: 401 })).toBe(false);
      expect(isRetryableError({ status: 402 })).toBe(false);
      expect(isRetryableError({ status: 404 })).toBe(false);
      expect(isRetryableError(new Error('Connection refused'))).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
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
