import { getLogger } from '../utils/logger';

interface CircuitState {
  failures: number;
  lastFailure: number;
  halfOpen: boolean;
  halfOpenTime: number;
  effectiveResetMs: number;
}

const DEFAULT_CONFIG = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  halfOpenMaxRequests: 1,
  cooldownPeriodMs: 30_000,
};

export class CircuitBreaker {
  private states: Map<string, CircuitState> = new Map();
  private config: typeof DEFAULT_CONFIG;

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private static withJitter(baseMs: number): number {
    const jitter = 0.7 + Math.random() * 0.6;
    return Math.round(baseMs * jitter);
  }

  isAllowed(provider: string): boolean {
    const state = this.states.get(provider);
    if (!state) return true;

    if (state.failures >= this.config.failureThreshold) {
      const elapsed = Date.now() - state.lastFailure;

      if (state.halfOpen) {
        if (elapsed >= this.config.halfOpenMaxRequests * 1000) {
          const tries = state.halfOpen ? 1 : 0;
          return tries < this.config.halfOpenMaxRequests;
        }
        return false;
      }

      if (elapsed >= state.effectiveResetMs) {
        state.halfOpen = true;
        state.halfOpenTime = Date.now();
        return true;
      }

      return false;
    }

    return true;
  }

  recordSuccess(provider: string): void {
    this.states.delete(provider);
    getLogger().debug({ provider }, 'Circuit breaker reset');
  }

  recordFailure(provider: string): void {
    const state = this.states.get(provider) || {
      failures: 0, lastFailure: 0, halfOpen: false, halfOpenTime: 0, effectiveResetMs: 0,
    };
    state.failures++;
    state.lastFailure = Date.now();

    if (state.halfOpen) {
      state.halfOpen = false;
      this.states.set(provider, state);
      getLogger().warn({ provider, failures: state.failures }, 'Circuit breaker half-open request failed');
    } else {
      if (state.failures >= this.config.failureThreshold) {
        state.effectiveResetMs = CircuitBreaker.withJitter(this.config.resetTimeoutMs);
        getLogger().warn({ provider, failures: state.failures }, 'Circuit breaker opened');
      }
      this.states.set(provider, state);
    }
  }

  getState(provider: string): { open: boolean; failures: number; remainingMs: number } {
    const state = this.states.get(provider);
    if (!state) return { open: false, failures: 0, remainingMs: 0 };

    if (state.failures >= this.config.failureThreshold) {
      const remainingMs = Math.max(0, state.effectiveResetMs - (Date.now() - state.lastFailure));
      return { open: true, failures: state.failures, remainingMs };
    }

    return { open: false, failures: state.failures, remainingMs: 0 };
  }
}