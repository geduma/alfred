import { ProviderConfig, ProviderType, LLMProvider } from '../../types/llm';

export class ProviderFactory {
  static async createProvider(config: ProviderConfig): Promise<LLMProvider> {
    const type: ProviderType = config.type;

    switch (type) {
      case 'openai-compatible':
      case 'openai': {
        const { OpenAICompatibleProvider } = await import('./openai-compatible.js');
        return new OpenAICompatibleProvider(config);
      }
      case 'anthropic': {
        const { AnthropicProvider } = await import('./anthropic.js');
        return new AnthropicProvider(config);
      }
      case 'gemini': {
        const { GeminiProvider } = await import('./gemini.js');
        return new GeminiProvider(config);
      }
      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }
}
