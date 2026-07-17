import fs from 'fs';
import { z } from 'zod';
import { AlfredConfig, ChannelConfig, DatabaseConfig, LoggingConfig, SecurityConfig, ToolSpecificConfig } from '../types/config';
import { LLMConfig, ProviderConfig } from '../types/llm';
import { resolvePath } from '../utils/workspace';

const ProviderConfigSchema = z.object({
  type: z.enum(['openai-compatible', 'anthropic', 'openai', 'gemini']),
  enabled: z.boolean(),
  model: z.string().min(1),
  config: z.object({
    api_url: z.string().url(),
    api_key: z.string().min(1),
    organization: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    timeout_seconds: z.number().positive().optional(),
  }),
  capabilities: z.object({
    supports_tools: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    supports_streaming: z.boolean().optional(),
  }).optional(),
});

const LLMConfigSchema = z.object({
  primary_provider: z.string().min(1),
  fallback_providers: z.array(z.string()),
  model_selection: z.enum(['automatic', 'manual']).optional(),
});

const ChannelConfigSchema = z.object({
  enabled: z.boolean(),
  type: z.string().min(1),
  config: z.record(z.unknown()),
  permissions: z.object({
    allow_from: z.array(z.string()).optional(),
    groups: z.record(z.object({
      require_mention: z.boolean().optional(),
    })).optional(),
  }).optional(),
});

const ToolConfigSchema = z.object({
  enabled: z.boolean(),
  config: z.record(z.unknown()).optional(),
});

const DatabaseConfigSchema = z.object({
  type: z.literal('sqlite'),
  config: z.object({
    path: z.string().min(1),
    memory: z.boolean().optional(),
    timeout_seconds: z.number().positive().optional(),
    journal_mode: z.string().optional(),
    foreign_keys: z.boolean().optional(),
  }),
});

const LoggingConfigSchema = z.object({
  level: z.string(),
  format: z.string(),
  targets: z.array(z.string()),
  config: z.object({
    file_path: z.string().optional(),
    max_size_mb: z.number().positive().optional(),
    retention_days: z.number().positive().optional(),
    rotate: z.boolean().optional(),
  }),
});

const SecurityConfigSchema = z.object({
  gateway_auth_token: z.string().min(16),
  rate_limiting: z.object({
    enabled: z.boolean(),
    requests_per_user_per_hour: z.number().positive(),
    requests_per_channel_per_hour: z.number().positive(),
  }).optional(),
  audit_logging: z.object({
    enabled: z.boolean(),
    log_file: z.string(),
  }).optional(),
});

const AlfredConfigSchema = z.object({
  agent: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    personality_file: z.string().min(1),
  }),
  llm: LLMConfigSchema,
  providers: z.record(z.string(), ProviderConfigSchema),
  channels: z.record(z.string(), ChannelConfigSchema),
  tools: z.record(z.string(), ToolConfigSchema),
  database: DatabaseConfigSchema,
  logging: LoggingConfigSchema,
  security: SecurityConfigSchema,
});

export class ConfigLoader {
  private config!: AlfredConfig;
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.reload();
  }

  reload(): AlfredConfig {
    const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    this.config = AlfredConfigSchema.parse(raw) as AlfredConfig;

    this.config.agent.personality_file = resolvePath(this.config.agent.personality_file);
    this.config.database.config.path = resolvePath(this.config.database.config.path);
    if (this.config.logging.config.file_path) {
      this.config.logging.config.file_path = resolvePath(this.config.logging.config.file_path);
    }

    this.validateProviderChain();
    return this.config;
  }

  resolvePath(p: string): string {
    return resolvePath(p);
  }

  private validateProviderChain(): void {
    const providerNames = Object.keys(this.config.providers);
    const allConfigured = [this.config.llm.primary_provider, ...this.config.llm.fallback_providers];

    for (const name of allConfigured) {
      if (!providerNames.includes(name)) {
        throw new Error(`Provider "${name}" referenced in llm config but not defined in providers section`);
      }
    }

    for (const [name, provider] of Object.entries(this.config.providers)) {
      if (!provider.enabled && name === this.config.llm.primary_provider) {
        throw new Error(`Primary provider "${name}" is disabled`);
      }
    }
  }

  get allConfig(): AlfredConfig {
    return this.config;
  }

  get llmConfig(): LLMConfig {
    return this.config.llm;
  }

  get providers(): Record<string, ProviderConfig> {
    return this.config.providers;
  }

  get channels(): Record<string, ChannelConfig> {
    return this.config.channels;
  }

  get tools(): Record<string, ToolSpecificConfig> {
    return this.config.tools;
  }

  get database(): DatabaseConfig {
    return this.config.database;
  }

  get logging(): LoggingConfig {
    return this.config.logging;
  }

  get security(): SecurityConfig {
    return this.config.security;
  }

  get agentName(): string {
    return this.config.agent.name;
  }

  get personalityFile(): string {
    return this.config.agent.personality_file;
  }

  get providerChain(): string[] {
    return [this.config.llm.primary_provider, ...this.config.llm.fallback_providers]
      .filter(name => this.config.providers[name]?.enabled);
  }

  get enabledChannels(): Array<{ name: string; config: ChannelConfig }> {
    return Object.entries(this.config.channels)
      .filter(([_, ch]) => ch.enabled)
      .map(([name, config]) => ({ name, config }));
  }

  get enabledTools(): string[] {
    return Object.entries(this.config.tools)
      .filter(([_, t]) => t.enabled)
      .map(([name]) => name);
  }
}
