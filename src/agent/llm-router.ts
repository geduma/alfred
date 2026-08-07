import { LLMCallParams, LLMResponse, LLMProvider, RetryConfig } from '../types/llm';
import { ConfigLoader } from '../config/loader';
import { ProviderFactory } from './providers/factory';
import { getLogger } from '../utils/logger';
import { CircuitBreaker } from '../services/circuit-breaker';
import { TokenBudgetTracker } from '../services/token-budget';
import { isThrottleError, isRetryableError, getErrorMessage } from '../utils/provider-errors';

const DEFAULT_RETRY: RetryConfig = {
  max_attempts: 3,
  base_delay_ms: 1000,
  max_delay_ms: 15000,
  backoff_factor: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class LLMRouter {
  private providers: Map<string, LLMProvider> = new Map();
  private providerChain: string[] = [];
  private currentIndex: number = 0;
  private config: ConfigLoader;
  private circuitBreaker: CircuitBreaker;
  private budgetTracker: TokenBudgetTracker;
  private retry: RetryConfig;

  constructor(config: ConfigLoader) {
    this.config = config;
    this.circuitBreaker = new CircuitBreaker();
    this.budgetTracker = new TokenBudgetTracker();
    this.retry = { ...DEFAULT_RETRY, ...config.llmConfig.retry };
  }

  async initialize(): Promise<void> {
    const chain = this.config.providerChain;

    for (const name of chain) {
      const providerConfig = this.config.providers[name];
      if (!providerConfig.enabled) continue;

      const provider = await ProviderFactory.createProvider(providerConfig);
      const valid = await provider.validateConfig();

      if (valid) {
        this.providers.set(name, provider);
        this.providerChain.push(name);
        getLogger().info({ provider: name }, 'Provider initialized');
      } else {
        getLogger().warn({ provider: name }, 'Provider validation failed, skipping');
      }
    }

    if (this.providerChain.length === 0) {
      throw new Error('No valid LLM providers configured');
    }

    getLogger().info(
      { chain: this.providerChain, primary: this.providerChain[0] },
      'LLM Router ready'
    );
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const startIndex = this.currentIndex;
    const attempts: Array<{ provider: string; error?: string }> = [];

    for (let i = 0; i < this.providerChain.length; i++) {
      const idx = (startIndex + i) % this.providerChain.length;
      const providerName = this.providerChain[idx];
      const provider = this.providers.get(providerName)!;

      if (!this.circuitBreaker.isAllowed(providerName)) {
        const state = this.circuitBreaker.getState(providerName);
        getLogger().debug(
          { provider: providerName, remainingMs: state.remainingMs },
          'Circuit breaker blocked provider'
        );
        attempts.push({ provider: providerName, error: 'Circuit breaker open' });
        continue;
      }

      let lastError: unknown;
      let exhausted = false;

      for (let attempt = 0; attempt < this.retry.max_attempts; attempt++) {
        try {
          getLogger().debug({ provider: providerName, attempt: attempt + 1 }, 'Calling LLM provider');
          const response = await provider.call(params);

          this.circuitBreaker.recordSuccess(providerName);
          this.currentIndex = 0;

          if (response.usage) {
            this.budgetTracker.trackUsage(response.usage);
          }

          return response;
        } catch (error: any) {
          lastError = error;
          const message = getErrorMessage(error);
          const retryable = isRetryableError(error);
          const isLastAttempt = attempt === this.retry.max_attempts - 1;

          if (!retryable) {
            if (!isThrottleError(message)) {
              this.circuitBreaker.recordFailure(providerName);
            }
            exhausted = true;
            break;
          }

          getLogger().warn(
            { provider: providerName, attempt: attempt + 1, error: message },
            'Provider call failed, retrying'
          );

          if (!isLastAttempt) {
            const delayMs = Math.min(
              this.retry.max_delay_ms,
              this.retry.base_delay_ms * Math.pow(this.retry.backoff_factor, attempt)
            );
            await sleep(delayMs);
          }
        }
      }

      if (!exhausted) {
        const message = getErrorMessage(lastError);
        if (!isThrottleError(message)) {
          this.circuitBreaker.recordFailure(providerName);
        }
      }

      getLogger().warn({ provider: providerName, error: getErrorMessage(lastError) }, 'Provider failed');
      attempts.push({ provider: providerName, error: getErrorMessage(lastError) });

      if (i < this.providerChain.length - 1) {
        this.currentIndex = (idx + 1) % this.providerChain.length;
      }
    }

    throw new Error(
      `All providers failed. Attempts: ${attempts.map(a => `${a.provider}: ${a.error}`).join(' | ')}`
    );
  }

  async reinitialize(config?: ConfigLoader): Promise<void> {
    if (config) {
      this.config = config;
    }
    this.retry = { ...DEFAULT_RETRY, ...this.config.llmConfig.retry };
    this.providers.clear();
    this.providerChain = [];
    this.currentIndex = 0;
    await this.initialize();
  }
}