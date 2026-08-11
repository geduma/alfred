import { LLMCallParams, LLMResponse, LLMProvider, RetryConfig, SpendingLimitsConfig, isPaidProvider } from '../types/llm';
import { ConfigLoader } from '../config/loader';
import { ProviderFactory } from './providers/factory';
import { getLogger } from '../utils/logger';
import { CircuitBreaker } from '../services/circuit-breaker';
import { TokenBudgetTracker } from '../services/token-budget';
import { isThrottleError, isRetryableError, getErrorMessage, BudgetBlockedError } from '../utils/provider-errors';

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
    this.budgetTracker = new TokenBudgetTracker(config);
    this.retry = { ...DEFAULT_RETRY, ...config.llmConfig.retry };
  }

  isPaid(providerName: string): boolean {
    const provider = this.config.providers[providerName];
    if (!provider) return false;
    return isPaidProvider(provider.type, provider.paid);
  }

  providerSupportsTools(name: string): boolean {
    const provider = this.config.providers[name];
    return provider?.capabilities?.supports_tools !== false;
  }

  messagesContainToolArtifacts(messages: LLMCallParams['messages']): boolean {
    return messages.some(m => m.role === 'tool' || (m.tool_calls !== undefined && m.tool_calls.length > 0));
  }

  stripToolArtifacts(messages: LLMCallParams['messages']): LLMCallParams['messages'] {
    return messages.flatMap(m => {
      if (m.role === 'tool') {
        return [];
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        return [{ role: m.role, content: m.content }];
      }
      return [m];
    });
  }

  getBudgetTracker(): TokenBudgetTracker {
    return this.budgetTracker;
  }

  getCircuitStates(): Array<{ provider: string; open: boolean; remainingMs: number }> {
    return this.providerChain.map(name => {
      const state = this.circuitBreaker.getState(name);
      return { provider: name, open: state.open, remainingMs: state.remainingMs };
    });
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
    const limits = this.config.llmConfig.spending_limits;
    let budgetBlocked = false;
    if (limits?.enabled) {
      const budget = await this.budgetTracker.checkBudget();
      budgetBlocked = !budget.allowed;
      if (budgetBlocked && limits.on_limit_reached === 'block_all') {
        throw new BudgetBlockedError(
          'The token budget for this period has been exhausted. Alfred is in degraded service mode until the next period. Adjust the limits in alfred.json to continue.'
        );
      }
    }

    const chain = this.buildChain(budgetBlocked, limits);
    const startIndex = this.currentIndex;
    const attempts: Array<{ provider: string; error?: string }> = [];

    if (Array.isArray(params.tools) && params.tools.length === 0 && this.messagesContainToolArtifacts(params.messages)) {
      getLogger().warn({}, 'Call has no tools but messages contain tool artifacts; stripping artifacts');
      params = { ...params, messages: this.stripToolArtifacts(params.messages) };
    }

    for (let i = 0; i < chain.length; i++) {
      const idx = (startIndex + i) % chain.length;
      const providerName = chain[idx];
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

      if (!this.providerSupportsTools(providerName)) {
        if (this.messagesContainToolArtifacts(params.messages)) {
          getLogger().warn(
            { provider: providerName },
            'Provider does not support tools but payload contains tool artifacts; skipping provider'
          );
          attempts.push({ provider: providerName, error: 'Provider lacks tool support and payload contains tool artifacts' });
          continue;
        }
        getLogger().warn(
          { provider: providerName },
          'Provider does not support tools; omitting tools for this call'
        );
      }

      const callParams = this.providerSupportsTools(providerName) ? params : { ...params, tools: undefined };

      let lastError: unknown;
      let exhausted = false;

      for (let attempt = 0; attempt < this.retry.max_attempts; attempt++) {
        try {
          getLogger().debug({ provider: providerName, attempt: attempt + 1 }, 'Calling LLM provider');
          const response = await provider.call(callParams);

          getLogger().debug(
            {
              trace: 'provider_call',
              provider: providerName,
              model: response.model || this.config.providers[providerName]?.model,
              input_tokens: response.usage?.input_tokens,
              output_tokens: response.usage?.output_tokens,
            },
            'LLM provider call succeeded'
          );

          this.circuitBreaker.recordSuccess(providerName);
          this.currentIndex = 0;

          if (response.usage) {
            this.budgetTracker.trackUsage(response.usage, providerName);
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

      if (i < chain.length - 1) {
        this.currentIndex = (idx + 1) % chain.length;
      }
    }

    throw new Error(
      `All providers failed. Attempts: ${attempts.map(a => `${a.provider}: ${a.error}`).join(' | ')}`
    );
  }

  private buildChain(budgetBlocked: boolean, limits?: SpendingLimitsConfig): string[] {
    if (budgetBlocked && limits?.on_limit_reached === 'block_paid_providers') {
      const free = this.providerChain.filter(name => !this.isPaid(name));
      if (free.length === 0) {
        throw new BudgetBlockedError(
          'The token limit was reached and no free providers are available. Alfred is in degraded service mode until the next period.'
        );
      }
      return free;
    }
    return this.providerChain;
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