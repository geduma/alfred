import { LLMConfig, ProviderConfig } from './llm';

export interface ToolSpecificConfig {
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface ChannelConfig {
  enabled: boolean;
  type: string;
  config: Record<string, unknown>;
  permissions?: {
    allow_from?: string[];
    trusted_proxies?: string[];
    groups?: Record<string, { require_mention?: boolean }>;
  };
}

export interface DatabaseConfig {
  type: 'sqlite';
  config: {
    path: string;
    memory?: boolean;
    timeout_seconds?: number;
    journal_mode?: string;
    foreign_keys?: boolean;
  };
}

export interface LoggingConfig {
  level: string;
  format: string;
  targets: string[];
  config: {
    file_path?: string;
    max_size_mb?: number;
    retention_days?: number;
    rotate?: boolean;
  };
}

export interface RateLimitingConfig {
  enabled: boolean;
  requests_per_user_per_hour: number;
  requests_per_channel_per_hour: number;
}

export interface SecurityConfig {
  gateway_auth_token: string;
  rate_limiting?: RateLimitingConfig;
  audit_logging?: {
    enabled: boolean;
    log_file: string;
  };
}

export interface MemoryConfig {
  max_context_tokens: number;
  max_verbatim_messages: number;
  compaction_threshold: number;
  compaction_model: string;
  summary_sections: string[];
  session_retention_days?: number;
  prompt_compression?: PromptCompressionConfig;
}

export interface PromptCompressionConfig {
  enabled: boolean;
  mode: 'telegraph' | 'off';
}

export interface VoiceProviderConfig {
  api_url?: string;
  api_key?: string;
}

export interface VoiceSttConfig {
  provider?: VoiceProviderConfig;
  model: string;
  language?: string;
}

export interface VoiceTtsConfig {
  provider?: VoiceProviderConfig;
  model: string;
  voice: string;
  response_format?: string;
  expose_to_model?: boolean;
}

export interface VoiceConfig {
  enabled: boolean;
  provider?: VoiceProviderConfig;
  timeout_seconds?: number;
  stt?: VoiceSttConfig;
  tts?: VoiceTtsConfig;
}

export interface RetentionConfig {
  tasks_days: number;
  messages_days: number;
  command_log_days: number;
  token_usage_log_days: number;
}

export interface AlfredConfig {
  agent: {
    name: string;
    version: string;
    personality_file: string;
    max_tool_iterations?: number;
    trace?: boolean;
  };
  llm: LLMConfig;
  providers: Record<string, ProviderConfig>;
  channels: Record<string, ChannelConfig>;
  tools: Record<string, ToolSpecificConfig>;
  database: DatabaseConfig;
  memory?: MemoryConfig;
  retention?: RetentionConfig;
  logging: LoggingConfig;
  security: SecurityConfig;
  health_monitor?: import('./notification').HealthMonitorConfig;
  voice?: VoiceConfig;
  server?: {
    port?: number;
    host?: string;
    web_auth_token?: string;
  };
}
