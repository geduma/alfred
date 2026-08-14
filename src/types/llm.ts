export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'tool_call_complete'; toolCall: ToolCall }
  | { type: 'usage'; input_tokens: number; output_tokens: number }
  | { type: 'finish'; stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'; model?: string }
  | { type: 'error'; error: unknown }
  | { type: 'heartbeat' };

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
  onEvent?: (event: LLMStreamEvent) => void;
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
  model?: string;
  raw?: unknown;
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
    max_context_tokens?: number;
    top_p?: number;
    timeout_seconds?: number;
  };
  paid?: boolean;
  capabilities?: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_streaming?: boolean;
  };
}

export function isPaidProvider(type: ProviderType, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return type === 'anthropic' || type === 'openai' || type === 'gemini';
}

export interface RetryConfig {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  backoff_factor: number;
}

export type LimitReachedPolicy = 'block_paid_providers' | 'block_all';

export interface SpendingLimitsConfig {
  enabled: boolean;
  daily_token_limit: number;
  monthly_token_limit: number;
  warn_threshold: number;
  on_limit_reached: LimitReachedPolicy;
}

export interface LLMStreamingConfig {
  initial_response_timeout_seconds?: number;
  idle_timeout_seconds?: number;
  max_total_time_seconds?: number | null;
}

export interface LLMConfig {
  primary_provider: string;
  fallback_providers: string[];
  model_selection?: 'automatic' | 'manual';
  retry?: RetryConfig;
  spending_limits?: SpendingLimitsConfig;
  streaming?: LLMStreamingConfig;
}
