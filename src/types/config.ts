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
  prompt_compression?: PromptCompressionConfig;
  vector_store?: VectorStoreConfig;
  snapshots?: SnapshotConfig;
}

export interface PromptCompressionConfig {
  enabled: boolean;
  mode: 'telegraph' | 'off';
  aggressive?: boolean;
}

export interface EmbeddingConfig {
  type: 'ollama' | 'openai' | 'openai-compatible' | 'hashing';
  model: string;
  dimension: number;
  config?: {
    api_url?: string;
    api_key?: string;
  };
  provider_ref?: string;
}

export interface VectorStoreConfig {
  enabled: boolean;
  type: 'lancedb';
  path: string;
  embedding: EmbeddingConfig;
  ingest: {
    on_message: boolean;
    max_chunk_size: number;
  };
  search: {
    top_k: number;
    min_score: number;
  };
}

export interface SnapshotConfig {
  enabled: boolean;
  auto_snapshot_interval: number;
  max_snapshots_per_session: number;
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
  logging: LoggingConfig;
  security: SecurityConfig;
  health_monitor?: import('./notification').HealthMonitorConfig;
  voice?: VoiceConfig;
  server?: {
    port?: number;
    host?: string;
  };
}
