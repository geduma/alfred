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
}

export interface AlfredConfig {
  agent: {
    name: string;
    version: string;
    personality_file: string;
  };
  llm: LLMConfig;
  providers: Record<string, ProviderConfig>;
  channels: Record<string, ChannelConfig>;
  tools: Record<string, ToolSpecificConfig>;
  database: DatabaseConfig;
  memory?: MemoryConfig;
  logging: LoggingConfig;
  security: SecurityConfig;
}
