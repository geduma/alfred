import { LLMProvider, LLMCallParams, LLMResponse, ProviderType, ProviderConfig } from '../../types/llm';

export abstract class BaseProvider implements LLMProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract call(params: LLMCallParams): Promise<LLMResponse>;

  async validateConfig(): Promise<boolean> {
    return !!(this.config.config.api_key && this.config.model);
  }

  protected getApiUrl(): string {
    return this.config.config.api_url;
  }

  protected getModel(): string {
    return this.config.model;
  }

  protected getTimeout(): number {
    return this.config.config.timeout_seconds || 30;
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
