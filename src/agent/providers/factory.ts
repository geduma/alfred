import { ProviderConfig, ProviderType, LLMProvider, LLMStreamingConfig } from '../../types/llm';

export class ProviderFactory {
  static async createProvider(config: ProviderConfig, streaming?: LLMStreamingConfig): Promise<LLMProvider> {
    const type: ProviderType = config.type;

    switch (type) {
      case 'openai-compatible':
      case 'openai': {
        const { OpenAICompatibleProvider } = await import('./openai-compatible.js');
        return new OpenAICompatibleProvider(config, streaming);
      }
      case 'anthropic': {
        const { AnthropicProvider } = await import('./anthropic.js');
        return new AnthropicProvider(config, streaming);
      }
      case 'gemini': {
        const { GeminiProvider } = await import('./gemini.js');
        return new GeminiProvider(config, streaming);
      }
      default:
        throw new Error(`Unsupported provider type: ${type}`);
    }
  }
}
