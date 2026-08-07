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
    max_context_tokens: z.number().positive().optional(),
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
  retry: z.object({
    max_attempts: z.number().int().min(1).max(10).default(3),
    base_delay_ms: z.number().int().min(0).default(1000),
    max_delay_ms: z.number().int().min(0).default(15000),
    backoff_factor: z.number().min(1).max(10).default(2),
  }).optional(),
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

const PromptCompressionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['telegraph', 'off']).default('telegraph'),
  aggressive: z.boolean().optional(),
});

const EmbeddingConfigSchema = z.object({
  type: z.enum(['ollama', 'openai', 'openai-compatible', 'hashing']).default('hashing'),
  model: z.string().default('nomic-embed-text'),
  dimension: z.number().positive().default(768),
  config: z.object({
    api_url: z.string().optional(),
    api_key: z.string().optional(),
  }).optional(),
  provider_ref: z.string().optional(),
});

const VectorStoreConfigSchema = z.object({
  enabled: z.boolean().default(false),
  type: z.literal('lancedb').default('lancedb'),
  path: z.string().default('/workspace/memory/vectors'),
  embedding: EmbeddingConfigSchema,
  ingest: z.object({
    on_message: z.boolean().default(true),
    max_chunk_size: z.number().positive().default(512),
  }),
  search: z.object({
    top_k: z.number().positive().default(5),
    min_score: z.number().min(0).max(1).default(0.5),
  }),
});

const SnapshotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  auto_snapshot_interval: z.number().positive().default(50),
  max_snapshots_per_session: z.number().positive().default(20),
});

const MemoryConfigSchema = z.object({
  max_context_tokens: z.number().positive().default(32000),
  max_verbatim_messages: z.number().positive().default(20),
  compaction_threshold: z.number().min(0).max(1).default(0.8),
  compaction_model: z.string().default('auto'),
  summary_sections: z.array(z.string()).default(['decisions', 'preferences', 'pending', 'context']),
  prompt_compression: PromptCompressionConfigSchema.optional(),
  vector_store: VectorStoreConfigSchema.optional(),
  snapshots: SnapshotConfigSchema.optional(),
});

const HealthMonitorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  check_interval_minutes: z.number().positive().default(60),
  severity_threshold: z.enum(['warn', 'error']).default('warn'),
  notifications: z.object({
    telegram: z.object({ enabled: z.boolean().default(false), chat_id: z.string().optional() }).optional(),
  }).default({}),
});

const AlfredConfigSchema = z.object({
  agent: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    personality_file: z.string().min(1),
    max_tool_iterations: z.number().int().positive().optional(),
  }),
  llm: LLMConfigSchema,
  providers: z.record(z.string(), ProviderConfigSchema),
  channels: z.record(z.string(), ChannelConfigSchema),
  tools: z.record(z.string(), ToolConfigSchema),
  database: DatabaseConfigSchema,
  memory: MemoryConfigSchema.optional(),
  logging: LoggingConfigSchema,
  security: SecurityConfigSchema,
  health_monitor: HealthMonitorConfigSchema.optional(),
});

export class ConfigLoader {
  private config!: AlfredConfig;
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.loadConfigSync();
  }

  private loadConfigSync(): AlfredConfig {
    const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    this.config = AlfredConfigSchema.parse(raw) as AlfredConfig;

    this.config.agent.personality_file = resolvePath(this.config.agent.personality_file);
    this.config.database.config.path = resolvePath(this.config.database.config.path);
    if (this.config.logging.config.file_path) {
      this.config.logging.config.file_path = resolvePath(this.config.logging.config.file_path);
    }
    const vs = this.config.memory?.vector_store;
    if (vs?.path) {
      vs.path = resolvePath(vs.path);
    }

    this.validateProviderChain();
    return this.config;
  }

  resolvePath(p: string): string {
    return resolvePath(p);
  }

  async reload(): Promise<AlfredConfig> {
    const raw = JSON.parse(await fs.promises.readFile(this.configPath, 'utf-8'));
    this.config = AlfredConfigSchema.parse(raw) as AlfredConfig;

    this.config.agent.personality_file = resolvePath(this.config.agent.personality_file);
    this.config.database.config.path = resolvePath(this.config.database.config.path);
    if (this.config.logging.config.file_path) {
      this.config.logging.config.file_path = resolvePath(this.config.logging.config.file_path);
    }
    const vs = this.config.memory?.vector_store;
    if (vs?.path) {
      vs.path = resolvePath(vs.path);
    }

    this.validateProviderChain();
    return this.config;
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

  get memoryConfig() {
    return this.config.memory;
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

  get healthMonitor() {
    return this.config.health_monitor;
  }
}
