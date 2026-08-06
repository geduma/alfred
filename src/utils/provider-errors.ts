const THROTTLE_PATTERN = /\b(429|413)\b|rate limit|too many requests|tokens[_ ]?per[_ ]?minute|request too large|reduce your message size|context window/i;

export const MIN_CONTEXT_BUDGET = 2048;

export function isThrottleError(message: string): boolean {
  return THROTTLE_PATTERN.test(message);
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
