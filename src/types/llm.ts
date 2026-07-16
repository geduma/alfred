export interface LLMProvider {
  call(params: LLMCallParams): Promise<LLMResponse>;
  validateConfig(): Promise<boolean>;
}

export interface LLMCallParams {
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  system?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ProviderType = 'openai-compatible' | 'anthropic' | 'openai' | 'gemini';

export interface ProviderConfig {
  type: ProviderType;
  enabled: boolean;
  model: string;
  config: {
    api_url: string;
    api_key: string;
    organization?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    timeout_seconds?: number;
  };
  capabilities?: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_streaming?: boolean;
  };
}

export interface LLMConfig {
  primary_provider: string;
  fallback_providers: string[];
  model_selection?: 'automatic' | 'manual';
}
