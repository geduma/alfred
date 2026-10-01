const THROTTLE_PATTERN = /\b(429|413)\b|rate limit|too many requests|tokens[_ ]?per[_ ]?minute|request too large|reduce your message size|context window/i;

const RETRYABLE_STATUS = new Set([408, 409, 413, 425, 429, 500, 502, 503, 504]);

const NETWORK_ERROR_PATTERN = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|request timed out|timeout|timed out|temporarily unavailable)\b/i;

export const MIN_CONTEXT_BUDGET = 2048;

export function isThrottleError(message: string): boolean {
  return THROTTLE_PATTERN.test(message);
}

export function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as any).message;
    if (typeof message === 'string') return message;
    return JSON.stringify(error);
  }
  return String(error ?? '');
}

export function getErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const status = (error as any).status;
    const numeric = typeof status === 'string' ? parseInt(status, 10) : status;
    if (typeof numeric === 'number' && numeric >= 100 && numeric < 600) {
      return numeric;
    }
  }
  const match = getErrorMessage(error).match(/\b(status)?\s*([45]\d{2})\b/i);
  if (match) {
    const parsed = parseInt(match[2], 10);
    if (parsed >= 100 && parsed < 600) return parsed;
  }
  return null;
}

export function isRetryableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status !== null && RETRYABLE_STATUS.has(status)) {
    return true;
  }
  const message = getErrorMessage(error);
  if (THROTTLE_PATTERN.test(message)) {
    return true;
  }
  return NETWORK_ERROR_PATTERN.test(message);
}

export function parseRequestedTokens(message: string): number | null {
  const match = message.match(/Requested\s+(\d+)/i);
  if (!match) return null;
  const tokens = parseInt(match[1], 10);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

export function nextContextBudget(current: number, requested: number | null): number {
  let next = Math.floor(current * 0.7);
  if (requested) {
    next = Math.min(next, Math.floor(requested * 0.85));
  }
  return Math.max(MIN_CONTEXT_BUDGET, next);
}

export class BudgetBlockedError extends Error {
  readonly code = 'BUDGET_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'BudgetBlockedError';
  }
}

export function isBudgetBlockedError(error: unknown): boolean {
  return error instanceof BudgetBlockedError || (error as any)?.code === 'BUDGET_BLOCKED';
}
