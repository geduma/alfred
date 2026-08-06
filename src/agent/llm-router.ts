import { LLMCallParams, LLMResponse, LLMProvider } from '../types/llm';
import { ConfigLoader } from '../config/loader';
import { ProviderFactory } from './providers/factory';
import { getLogger } from '../utils/logger';
import { CircuitBreaker } from '../services/circuit-breaker';
import { TokenBudgetTracker } from '../services/token-budget';
import { isThrottleError } from '../utils/provider-errors';

export class LLMRouter {
  private providers: Map<string, LLMProvider> = new Map();
  private providerChain: string[] = [];
  private currentIndex: number = 0;
  private config: ConfigLoader;
  private circuitBreaker: CircuitBreaker;
  private budgetTracker: TokenBudgetTracker;

  constructor(config: ConfigLoader) {
    this.config = config;
    this.circuitBreaker = new CircuitBreaker();
    this.budgetTracker = new TokenBudgetTracker();
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

      try {
        getLogger().debug({ provider: providerName }, 'Calling LLM provider');
        const response = await provider.call(params);

        this.circuitBreaker.recordSuccess(providerName);
        this.currentIndex = 0;

        if (response.usage) {
          this.budgetTracker.trackUsage(response.usage);
        }

        return response;
      } catch (error: any) {
        if (isThrottleError(error.message)) {
          getLogger().warn(
            { provider: providerName, error: error.message },
            'Provider throttled, circuit breaker not opened'
          );
        } else {
          this.circuitBreaker.recordFailure(providerName);
          getLogger().warn({ provider: providerName, error: error.message }, 'Provider failed');
        }
        attempts.push({ provider: providerName, error: error.message });

        if (i < this.providerChain.length - 1) {
          this.currentIndex = (idx + 1) % this.providerChain.length;
        }
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
    this.providers.clear();
    this.providerChain = [];
    this.currentIndex = 0;
    await this.initialize();
  }
}