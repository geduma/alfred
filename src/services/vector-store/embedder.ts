import axios from 'axios';
import { getLogger } from '../../utils/logger';
import { EmbeddingConfig } from '../../types/config';
import { ProviderConfig } from '../../types/llm';

export interface Embedder {
  embed(text: string): Promise<number[]>;
  readonly dimension: number;
}

class OllamaEmbedder implements Embedder {
  public readonly dimension: number;
  private baseUrl: string;
  private model: string;

  constructor(config: { api_url: string; model: string; dimension: number }) {
    this.baseUrl = config.api_url.replace(/\/v1$/, '').replace(/\/$/, '');
    this.model = config.model;
    this.dimension = config.dimension || 768;
  }

  async embed(text: string): Promise<number[]> {
    const res = await axios.post(
      `${this.baseUrl}/api/embeddings`,
      { model: this.model, prompt: text },
      { timeout: 10000 }
    );

    const embedding = res.data?.embedding || res.data?.embeddings?.[0];
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Invalid embedding response from Ollama');
    }

    return embedding;
  }
}

class OpenAIEmbedder implements Embedder {
  public readonly dimension: number;
  private apiKey: string;
  private model: string;

  constructor(config: { api_key: string; model: string; dimension: number }) {
    this.apiKey = config.api_key;
    this.model = config.model;
    this.dimension = config.dimension || 1536;
  }

  async embed(text: string): Promise<number[]> {
    const res = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { model: this.model, input: text },
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 15000,
      }
    );

    const embedding = res.data?.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Invalid embedding response from OpenAI');
    }

    return embedding;
  }
}

class OpenAICompatibleEmbedder implements Embedder {
  public readonly dimension: number;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: { api_url: string; api_key: string; model: string; dimension: number }) {
    this.baseUrl = config.api_url.replace(/\/$/, '');
    this.apiKey = config.api_key;
    this.model = config.model;
    this.dimension = config.dimension || 768;
  }

  async embed(text: string): Promise<number[]> {
    const res = await axios.post(
      `${this.baseUrl}/embeddings`,
      { model: this.model, input: text },
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const embedding = res.data?.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Invalid embedding response from OpenAI-compatible API');
    }

    return embedding;
  }
}

export function createEmbedder(
  embeddingConfig: EmbeddingConfig,
  allProviders?: Record<string, ProviderConfig>
): Embedder {
  let effectiveConfig = { ...embeddingConfig };

  if (effectiveConfig.provider_ref && allProviders) {
    const refProvider = allProviders[effectiveConfig.provider_ref];
    if (refProvider) {
      if (refProvider.type === 'openai-compatible' || refProvider.type === 'openai') {
        if (!effectiveConfig.config) {
          effectiveConfig.config = {};
        }
        if (!effectiveConfig.config.api_url) {
          effectiveConfig.config.api_url = refProvider.config.api_url;
        }
        if (!effectiveConfig.config.api_key) {
          effectiveConfig.config.api_key = refProvider.config.api_key;
        }
        if (!effectiveConfig.model) {
          effectiveConfig.model = refProvider.model;
        }
        if (!effectiveConfig.type) {
          effectiveConfig.type = refProvider.type;
        }
      } else {
        getLogger().warn(
          { provider_ref: effectiveConfig.provider_ref, type: refProvider.type },
          'Referenced provider does not support embeddings, falling back to explicit config'
        );
      }
    } else {
      getLogger().warn(
        { provider_ref: effectiveConfig.provider_ref },
        'provider_ref not found, falling back to embedding config as-is'
      );
    }
  }

  return buildEmbedder(effectiveConfig);
}

function buildEmbedder(config: EmbeddingConfig): Embedder {
  const apiUrl = config.config?.api_url;
  const apiKey = config.config?.api_key;
  const model = config.model || 'nomic-embed-text';
  const dimension = config.dimension || 768;

  switch (config.type) {
    case 'ollama': {
      const url = apiUrl || 'http://localhost:11434';
      return new OllamaEmbedder({ api_url: url, model, dimension });
    }
    case 'openai': {
      const key = apiKey || '';
      return new OpenAIEmbedder({ api_key: key, model, dimension });
    }
    case 'openai-compatible': {
      if (!apiUrl) {
        throw new Error('api_url required for openai-compatible embedding provider');
      }
      const key = apiKey || '';
      return new OpenAICompatibleEmbedder({ api_url: apiUrl, api_key: key, model, dimension });
    }
    default:
      throw new Error(`Unsupported embedding type: ${config.type}`);
  }
}
