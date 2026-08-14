import { LLMProvider, LLMCallParams, LLMResponse, LLMStreamEvent, ProviderType, ProviderConfig, LLMStreamingConfig } from '../../types/llm';
import { accumulateStream, StreamTimeoutConfig } from './stream-utils';

export const DEFAULT_STREAMING_TIMEOUTS_S: Required<LLMStreamingConfig> = {
  initial_response_timeout_seconds: 120,
  idle_timeout_seconds: 60,
  max_total_time_seconds: null,
};

export abstract class BaseProvider implements LLMProvider {
  protected config: ProviderConfig;
  protected streaming: Required<LLMStreamingConfig>;

  constructor(config: ProviderConfig, streaming?: LLMStreamingConfig) {
    this.config = config;
    this.streaming = {
      ...DEFAULT_STREAMING_TIMEOUTS_S,
      ...(streaming || {}),
    };
    this.streaming.max_total_time_seconds = streaming?.max_total_time_seconds ?? null;
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    if (!this.isStreamingEnabled()) {
      return this.callNonStreaming(params);
    }

    const controller = new AbortController();
    try {
      const events = this.streamEvents(params, controller.signal);
      return await accumulateStream(events, params, controller, this.getStreamingTimeouts(), this.getModel());
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

  protected getStreamingTimeouts(): StreamTimeoutConfig {
    return {
      initialMs: this.streaming.initial_response_timeout_seconds * 1000,
      idleMs: this.streaming.idle_timeout_seconds * 1000,
      totalMs: this.streaming.max_total_time_seconds ? this.streaming.max_total_time_seconds * 1000 : null,
    };
  }

  protected getStreamTransportTimeoutMs(): number {
    const { initialMs, idleMs, totalMs } = this.getStreamingTimeouts();
    if (totalMs !== null) return totalMs;
    return initialMs + idleMs;
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
