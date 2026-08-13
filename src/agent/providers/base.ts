import { LLMProvider, LLMCallParams, LLMResponse, LLMStreamEvent, ProviderType, ProviderConfig } from '../../types/llm';
import { accumulateStream, StreamTimeoutConfig } from './stream-utils';

export abstract class BaseProvider implements LLMProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    if (!this.isStreamingEnabled()) {
      return this.callNonStreaming(params);
    }

    const controller = new AbortController();
    try {
      const timeouts: StreamTimeoutConfig = {
        initialMs: this.getInitialTimeoutMs(),
        idleMs: this.getIdleTimeoutMs(),
        totalMs: this.getTotalTimeoutMs(),
      };
      const events = this.streamEvents(params, controller.signal);
      return await accumulateStream(events, params, controller, timeouts, this.getModel());
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  async validateConfig(): Promise<boolean> {
    return !!(this.config.config.api_key && this.config.model);
  }

  protected abstract callNonStreaming(params: LLMCallParams): Promise<LLMResponse>;

  protected abstract streamEvents(params: LLMCallParams, signal: AbortSignal): AsyncGenerator<LLMStreamEvent>;

  protected isStreamingEnabled(): boolean {
    return this.config.capabilities?.supports_streaming !== false;
  }

  protected getApiUrl(): string {
    return this.config.config.api_url;
  }

  protected getModel(): string {
    return this.config.model;
  }

  protected getTimeout(): number {
    return this.config.config.timeout_seconds || 60;
  }

  protected getInitialTimeoutMs(): number {
    return this.getTimeout() * 1000;
  }

  protected getIdleTimeoutMs(): number {
    return (this.config.config.stream_idle_timeout_seconds || 60) * 1000;
  }

  protected getTotalTimeoutMs(): number | null {
    return this.config.config.max_total_time_seconds ? this.config.config.max_total_time_seconds * 1000 : null;
  }

  protected getTemperature(): number {
    return this.config.config.temperature ?? 0.8;
  }

  protected getMaxTokens(): number {
    return this.config.config.max_tokens || 4096;
  }

  static getType(): ProviderType {
    throw new Error('Provider must implement getType()');
  }
}
