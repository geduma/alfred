import { ProviderConfig, ProviderType, LLMProvider } from '../../types/llm';
import { OpenAICompatibleProvider } from './openai-compatible';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';

export class ProviderFactory {
  static createProvider(config: ProviderConfig): LLMProvider {
    const type: ProviderType = config.type;

    switch (type) {
      case 'openai-compatible':
      case 'openai':
        return new OpenAICompatibleProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'gemini':
        return new GeminiProvider(config);
      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }
}
