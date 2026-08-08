# AGENTS.md — Instructions for AI Agents

## Project: Alfred Pennyworth — Multi-channel Personal AI Agent

---

## Stack

- **Runtime:** Node.js 22 LTS
- **Language:** TypeScript 5.4+ (strict mode)
- **Database:** SQLite3 embedded
- **WebSocket:** ws@8.17
- **Logging:** pino@8.18
- **Validation:** zod@3.22
- **Test:** Jest + ts-jest
- **Docker:** node:22-alpine (base ~180MB; final image est. ~0.5-1.0GB tras eliminar WhatsApp/Chromium)

## Commands

```bash
npm run build        # Compile TypeScript
npm run dev          # Development with hot-reload (tsx watch)
npm start            # Production
npm test             # Jest
npm run lint         # ESLint
npm run docker:build # docker compose build
npm run docker:up    # docker compose up -d
```

## Project Structure

```
src/
├── index.ts                  ← Entry point (wires all modules, auto-creates configs)
├── gateway.ts                ← WebSocket server (port 18789) + SessionStore + JobRunner + Context Compressor
├── config/loader.ts          ← Config loader with Zod validation
├── agent/
│   ├── llm-router.ts         ← Router with automatic fallback chain
│   ├── prompt-builder.ts     ← System prompt = SOUL.md + preferences.md + rules.md + base
│   ├── soul-loader.ts        ← Personality file loader
│   └── providers/            ← LLM abstraction layer
│       ├── base.ts           ← Abstract provider
│       ├── factory.ts        ← Factory pattern
│       ├── openai-compatible.ts  ← Ollama, RunPod, LocalAI
│       ├── anthropic.ts      ← Claude
│       └── gemini.ts         ← Gemini
├── services/
│   ├── context-compressor.ts ← Sliding window + LLM summarization for context management
│   ├── prompt-compressor.ts  ← Telegraph English — rule-based prompt compression
│   ├── token-budget.ts       ← Token budget + spending limits (daily/monthly, paid-provider gating)
│   ├── circuit-breaker.ts    ← Circuit breaker with jitter for provider resilience
│   ├── vector-store/
│   │   ├── index.ts          ← LanceDB vector store manager (init, ingest, search, delete)
│   │   └── embedder.ts      ← Agnostic embedder factory (hashing, Ollama, OpenAI, OpenAI-compatible)
│   ├── snapshot.ts           ← Session snapshots for long-term memory checkpoints
│   ├── health-monitor.ts     ← Periodic log scanner, error categorizer, alert generator
│   └── notification.ts      ← Alert delivery (Telegram, with email-ready architecture)
├── tools/                    ← Universal tools (exec, file_ops, web, job, system, health + conditional memory)
│   ├── exec.ts               ← Async shell (cross-spawn) with allowlist/denylist
│   ├── file-ops.ts           ← File CRUD with multi-path permission rules
│   ├── web.ts                ← Unified web search + fetch (action: "search" | "fetch")
│   ├── job-scheduler.ts      ← Create/list/update/cancel reminders
│   ├── system.ts             ← health/reload/status via gateway
│   ├── health.ts             ← Health monitor + budget status + circuit states (actions: status|budget|findings|check|configure)
│   └── memory.ts             ← Memory tools (search, snapshots, snapshot_get, snapshot_restore)
├── channels/                 ← Communication channels
│   ├── channel-manager.ts
│   ├── telegram.ts           ← Grammy bot
│   ├── cli.ts                ← Interactive readline
│   └── web.ts                ← Push-only WebChannel (web clients register and receive broadcasts)
├── db/                       ← Persistence
│   ├── schema.ts             ← Embedded SQL schema (6 tables: + token_usage_log)
│   ├── index.ts              ← Init + migrations + closeDatabase()
│   ├── session-store.ts      ← Session serialization to workspace/memory/sessions/
│   └── repositories/         ← Sessions, Messages, Commands, TokenUsage
├── security/
│   └── rate-limiter.ts       ← Rate limiting by user/channel
├── types/                    ← TypeScript interfaces (MemoryConfig added)
└── utils/
    ├── logger.ts             ← Pino structured logger
    └── token-counter.ts      ← Token estimation for context management
```

## Code Conventions

- TypeScript strict: `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- Exported classes, interfaces in `src/types/`
- No comments in code
- Errors handled with try/catch and logged via `getLogger()`
- File names: kebab-case (e.g. `web-search.ts`, `file-ops.ts`)
- Tools implement `ToolHandler` from `src/types/tool.ts`
- Channels implement `Channel` from `src/types/channel.ts`

## Configuration

Single file: `workspace/config/alfred.json`

- `llm.primary_provider` → Active provider
- `llm.fallback_providers` → Fallback chain
- `providers` → Full provider list (each with `type`, `enabled`, `model`, `config`; `paid: true` marks a provider as paid for spending-limit gating)
- `tools` → Per-tool configuration
- `channels` → Channel + permissions (ACL via `allow_from`); `web` is a push-only channel for web clients
- `database` → SQLite path + settings
- `memory` → Context compression, prompt compression, vector store, and snapshot settings
- `memory.prompt_compression` → Telegraph English compression (enabled, mode: telegraph|off; `aggressive` is evaluated but kept `false`)
- `memory.vector_store` → LanceDB RAG config (embedding provider, search params, ingest settings)
- `memory.snapshots` → Session snapshot config (auto interval, max per session)
- `spending_limits` → Optional. If the section is missing, spending control is disabled (zero change vs v2.1). `enabled` default `false`, `warn_threshold` default `0.8`, `on_limit_reached` default `block_paid_providers`
- `server` → Optional. `port` (default 18789, `0` allowed for tests), `host` (default `0.0.0.0`)
- `security.gateway_auth_token` → Minimum 16 characters

## Universal Tools

| Tool | File | Domain |
|---|---|---|
| `exec` | `src/tools/exec.ts` | Async shell commands with allowlist/denylist (cross-spawn, timeout, sanitized env) |
| `file_ops` | `src/tools/file-ops.ts` | Read/write/edit/delete/list files in permitted paths |
| `web` | `src/tools/web.ts` | Web search (DuckDuckGo) and URL fetch (cheerio) |
| `job` | `src/tools/job-scheduler.ts` | CRUD reminders, persisted to workspace/memory/jobs/, delivers to originating channel/chat |
| `system` | `src/tools/system.ts` | Health/status/reload delegated to gateway |
| `health` | `src/tools/health.ts` | Health monitor + budget status + circuit states (`status`/`budget`/`findings`/`check`/`configure`) |
| `memory` | `src/tools/memory.ts` | Conditional — search, snapshots, snapshot_get, snapshot_restore |

## Personality System

- **SOUL.md** (`workspace/config/SOUL.md`) — Core identity, user-editable only
- **preferences.md** (`workspace/memory/personality/preferences.md`) — Dynamic preferences managed by the LLM via `file_ops`
- **alfred-rules.md** (`config/alfred-rules.md`) — File access rules + personality protocol + job protocol + skill implementation protocol, injected into system prompt
- The LLM reads/writes `preferences.md` when the user requests behavior changes (language, tone, formality, etc.)

## Skill Implementation Protocol

When the user requests new functionality via any channel, Alfred's default
response is to implement it as a **SKILL.md** file in `/workspace/skills/custom/`.

- **SKILL.md format**: YAML frontmatter (name, description, metadata) + markdown body (overview, when to use, how to use)
- **Tools used**: The skill instructs Alfred how to orchestrate `exec`, `file_ops`, `web`, `job`, and `system` tools
- **Fallback**: If the functionality requires capabilities beyond these tools, Alfred explains why and requests code implementation
- **Rule location**: `system/alfred-rules.md` → section "Skill Implementation Protocol"

Skills directories:
```
/workspace/skills/
├── custom/    ← User-requested custom skills
├── system/    ← System-level skills
├── web/       ← Web-oriented skills
└── files/     ← File-oriented skills
```

## Secrets Management

Skill credentials (API keys, tokens, passwords for external services) are stored
in `workspace/config/secrets.env`. This file is **read-only** for Alfred (enforced
by `file-ops.ts` permissions on `/workspace/config`).

- **Not for LLM config**: Provider API keys remain in `alfred.json`
- **SKILL.md references**: Skills declare required env vars via `metadata.requires.env`
- **exec tool**: Supports an `env` parameter — secrets are passed to the child
  process and automatically sanitized from logs (`src/tools/exec.ts`)
- **Protocol**: Documented in `system/alfred-rules.md` → "Secrets Management Protocol"
- **Template**: `system/secrets.env.example` — auto-created on first startup

Alfred must never output secret values in responses or log them. The `exec` tool's
`env` parameter is the only approved channel for passing secrets to commands.

## Job Scheduler

- Reminders stored as JSON in `workspace/memory/jobs/{id}.json`
- Supports: one-time (`delay_minutes`), daily, weekly (`day_of_week`), monthly (`day_of_month`)
- Recurring jobs auto-compute next fire time
- JobRunner in gateway checks every 30 seconds
- Notifications sent to the originating channel (or all channels if not specified)
- User can list, update, and cancel any job

## Session Persistence

- Sessions stored in `workspace/memory/sessions/{sessionId}.json`
- Loaded from disk on startup, saved after each interaction
- Survives container restarts
- Sessions now include an optional `summary` field generated by the context compressor

## Context Compression

Alfred uses a **Sliding Window + Summary** strategy to prevent unbounded context growth:

- **Token budget**: `memory.max_context_tokens` (default: 32000) controls the soft limit
- **Adaptive provider budget**: On a 413/request-too-large error, Alfred learns the provider's real context limit and persists it to `workspace/memory/provider-budgets.json`, then auto-compacts and retries (up to 3 cycles, then once without tools). Provider-specific values are never hardcoded; `provider.config.max_context_tokens` is an optional manual override.
- **Output token cap**: `max_tokens` per call is derived from the effective context budget (`max(512, budget × 0.35)`), capped by the configured `max_tokens`, so output shrinks when the learned budget does.
- **Compaction trigger**: When context exceeds `max_context_tokens × compaction_threshold` (default: 80%), compression activates
- **Sliding window**: The last `max_verbatim_messages` (default: 20) are kept verbatim for precise recall
- **LLM summarization**: Older messages are compressed into a structured summary via the LLM, preserving decisions, preferences, pending tasks, and key facts
- **Structured format**: Summary uses sections: DECISIONS, PREFERENCES, PENDING, CONTEXT, KEY_FACTS
- **Fallback**: If LLM summarization fails, a heuristic fallback extracts key points from recent messages

Key implementation files:
- `src/services/context-compressor.ts` — Core compression logic (token estimation, LLM summarization, fallback)
- `src/utils/token-counter.ts` — Token estimation utility (≈4 chars/token heuristic)
- `src/db/session-store.ts` — StoredSession now includes `summary` and optional `summarySections` fields

## Prompt Compression (Telegraph English)

Alfred applies **Telegraph English** compression to the system prompt before every LLM call:

- **Rule-based**: Removes articles, auxiliary verbs, filler words, and shortens verbose phrases
- **Zero dependencies**: Pure TypeScript, no Python, no models
- **Latency:** <10ms per request
- **Compression ratio:** ~20-35% (standard mode), ~30-45% (aggressive mode)
- **Config**: `memory.prompt_compression` in alfred.json (`enabled`, `mode: "telegraph"|"off"`, `aggressive`)
- **Fallback**: Set `mode: "off"` to disable (no performance impact)

## Vector Store / RAG (LanceDB)

Alfred uses **LanceDB** (embedded vector database) for long-term semantic memory:

- **Embedding**: Built-in hashing vectorizer — zero dependencies, no external APIs, no API keys, ~5μs per embedding
- **Ingest**: Every user message, tool response, and assistant reply is embedded and stored
- **Search**: On each query, Alfred retrieves top-K semantically similar chunks from past sessions
- **Injection**: Results are injected as `[RAG CONTEXT — Retrieved from long-term memory]` messages
- **Config**: `memory.vector_store` in alfred.json (model, paths, search params)
- **Auto-disable**: If embedder initialization fails, vector store is gracefully disabled with a log warning

Key implementation files:
- `src/services/vector-store/index.ts` — LanceDB init, ingest, search, delete
- `src/services/vector-store/embedder.ts` — Agnostic embedder factory

### Embedding

**Default provider:** `hashing` — zero-dependency hashing vectorizer built into Alfred. No API keys, no external services, no model downloads, ~5μs per embedding. Uses word frequency hashing (djb2) + L2 normalization. Configurable dimension (default: 256).

**Other supported providers:** `openai-compatible` (Ollama, RunPod, LocalAI), `openai`, `ollama` (native API). These require API keys or a running external service.

`provider_ref` references an existing LLM provider to reuse its `api_url`/`api_key` (only for `openai-compatible` and `openai` types).

```json
// Built-in hashing vectorizer (recommended — zero deps, no external APIs)
"embedding": { "type": "hashing", "dimension": 256 }

// Using OpenAI API (requires api_key)
"embedding": { "type": "openai", "model": "text-embedding-3-small", "dimension": 1536, "config": { "api_key": "sk-..." } }

// Using local Ollama (requires Ollama running)
"embedding": { "type": "ollama", "model": "nomic-embed-text", "dimension": 768, "config": { "api_url": "http://localhost:11434" } }

// Any OpenAI-compatible endpoint
"embedding": { "type": "openai-compatible", "model": "nomic-embed-text", "dimension": 768, "config": { "api_url": "https://your-endpoint/v1", "api_key": "..." } }
```

## Health Monitor

Alfred includes a periodic **health monitor** that scans application logs for errors and warnings:

- **Interval**: Configurable via `health_monitor.check_interval_minutes` (default: 60 min)
- **Severity threshold**: `warn` (level >= 40) or `error` (level >= 50) — configurable
- **Categories**: `vector_store`, `llm_provider`, `telegram`, `database`, `tool_execution`, `session`, `snapshot`, `job_scheduler`, `other`
- **State persistence**: Tracks last scanned byte position across restarts (`workspace/memory/health-monitor-state.json`)
- **Alert delivery**: Telegram (via `channelManager.sendMessage`). Email-ready architecture via `NotificationService`.
- **LLM-accessible**: The `health` tool allows Alfred to respond to queries like _"health findings"_ or _"trigger a health check now"_

### Health Tool

```json
{
  "name": "health",
  "actions": ["status", "budget", "findings", "check", "configure"],
  "filters": { "severity_threshold": "warn|error", "category": "string" }
}
```

**Available via CLI/Telegram:** `health findings`, `health findings severity=error`, `health check`, `health budget`, `health status`

- `status` → consolidated: health monitor + findings + token budget + circuit states
- `budget` → daily/monthly allowance, remaining %, per-provider usage (incl. paid markers)
- `findings` / `check` / `configure` → health monitor operations

### Config

```json
{
  "health_monitor": {
    "enabled": true,
    "check_interval_minutes": 60,
    "severity_threshold": "warn",
    "notifications": {
      "telegram": { "enabled": true }
    }
  }
}
```

Key implementation files:
- `src/services/health-monitor.ts` — Log scanner, error categorization, state management, alert triggering
- `src/services/notification.ts` — Alert delivery to Telegram and future email channels
- `src/tools/health.ts` — LLM-accessible health tool
- `src/types/notification.ts` — TypeScript interfaces

## Snapshots

Snapshots are point-in-time session checkpoints for long-term memory recall:

- **Auto-snapshot**: Creates a snapshot every N messages (`auto_snapshot_interval`, default: 50)
- **Manual**: Programmatic via SnapshotManager API (future tool integration)
- **Pruning**: Oldest snapshots are auto-deleted when exceeding `max_snapshots_per_session`
- **Storage**: JSON files in `workspace/memory/snapshots/`
- **Integration**: Snapshots tag vectors in LanceDB for cross-session search filtering
- **Config**: `memory.snapshots` in alfred.json (enabled, interval, max)

The snapshot pipeline in `prepareContext()` runs after each successful interaction, checking the message counter against the configured interval.

## Spending Limits (v2.2)

Token-based budget control with real spend tracking persisted in SQLite (`token_usage_log`):

- **Per-request tracking**: `LLMRouter.call()` records usage per provider after each call
- **Daily/monthly caps**: `spending_limits.daily_tokens` / `monthly_tokens`; remaining % = `min(daily, monthly)`
- **Enforcement**: `on_limit_reached` = `block_all` (throw `BudgetBlockedError`) or `block_paid_providers` (filter out `paid: true` providers from the fallback chain; throws if nothing is left). If `spending_limits` is absent, no gating happens (v2.1 behavior)
- **Warnings**: `evaluateWarning()` dedupes per period; gateway sends a `warn` alert via `NotificationService` when remaining crosses `warn_threshold`
- **Degraded mode**: when the budget is exhausted the gateway replies with a degraded message instead of calling the router
- **Context override**: when remaining < 20%, the compressor threshold is overridden to 0.6 for the request (reverted after)
- **Errors**: `BudgetBlockedError` (code `'BUDGET_BLOCKED'`) + `isBudgetBlockedError()` in `src/utils/provider-errors.ts`
- **Tool access**: the `health` tool exposes `budget` and includes budget state in `status`

Key files: `src/services/token-budget.ts`, `src/db/repositories/token-usage.ts`, `src/agent/llm-router.ts`, `src/gateway.ts`

## Web Channel (v2.2)

The gateway serves a static web UI (`web/`) and exposes a WebSocket on the same HTTP server:

- **Routing**: single `http.Server` + `WebSocketServer({ noServer: true })`; upgrade requests for `/ws` → web client (no auth, **TODO**), any other path → main WS with `gateway_auth_token`
- **Web client**: push-only via `WebChannel` — registers on connect, receives broadcasts (`{ type: 'notify', event: 'message' }`); the `agent` method responds via the `agent_complete` event, so the frontend uses fire-and-forget `AlfredWS.send`
- **Config API**: `config_get` (api_key/gateway_auth_token sanitized as `*****`) and `config_update` (deep merge + `writeRaw`; requires `reload`)
- **Config**: `server.port` (default 18789, `0` for ephemeral/test), `server.host` (default `0.0.0.0`)
- **Docker**: `web/` copied in both builder and runtime stages; `deploy.sh` post-deploy healthcheck probes port 18789 (`nc -z`, `HEALTH_WAIT_SECONDS` default 60, exit 1 with logs on failure)

Key files: `src/gateway.ts`, `src/channels/web.ts`, `web/`, `src/config/loader.ts`

## Default Skills (v2.2)

On first startup Alfred auto-copies new files from `system/skills-custom/` into `workspace/skills/custom/` (copy-if-missing, never overwrites). `SkillLoader.loadSkills()` scans both the skills root and `skillsDir/custom`.

Bundled: `daily-digest`, `weekly-review`, `system-check` — with instructions in Spanish for the day-to-day agent use cases.

Key files: `system/skills-custom/`, `src/index.ts` (`copyDefaultSkills`), `src/agent/skill-loader.ts`

## LLM Provider Agnosticism (v2.2)

Alfred remains 100% agnostic to LLM providers — no code references any specific vendor (e.g. Relio). Provider-related strategies (routing strategy, cache-aware selection, cost-aware ranking) are **documentation-only** (README/AGENTS.md) and are not hardcoded in source. Add provider-specific behavior only through the Provider Factory pattern in `src/agent/providers/`.

## Auto-Created Configs

On first startup, if `workspace/config/alfred.json` or `workspace/config/SOUL.md` don't exist, they are auto-created from:
- `system/alfred.json.example`
- `system/SOUL.md.example`

The user is prompted to edit these files with real API keys.

If `security.gateway_auth_token` starts with `CHANGE_ME`, Alfred auto-generates a
random token and writes it back to the config **before** schema validation runs,
so a fresh volume boots without manual edits.

## Testing

- Unit tests in `tests/unit/`
- Jest with `ts-jest`, logger silenced via `tests/jest.setup.ts`
- Run: `npm test`
- Verify: `npx tsc --noEmit`, `npm run lint`, `npm run build`

## Docker

```bash
# Build
docker compose -f docker/docker-compose.yml build

# Run
docker compose -f docker/docker-compose.yml up -d

# Logs
docker compose -f docker/docker-compose.yml logs -f alfred
```

Volume: `~/.alfred-personal:/workspace`

## Performance Changes (v2.1)

| Change | File | What |
|--------|------|------|
| Concurrency control | `src/gateway.ts` | Max 3 concurrent tools, 60s per-tool timeout |
| Circuit breaker jitter | `src/services/circuit-breaker.ts` | ±30% jitter on reset timeout |
| WAL autocheckpoint | `src/db/index.ts` | Set to 1000 for write perf |
| SAFETY_MULTIPLIER | `src/utils/token-counter.ts` | 1.3 → 1.15 |
| Shutdown timeout | `src/gateway.ts` | 10s graceful shutdown |
| Token budget tracker | `src/services/token-budget.ts`, `src/agent/llm-router.ts` | Integrated in LLMRouter |
| Secrets filter universal | `src/tools/file-ops.ts` | Applies to all files, not just config |
| exec flag normalization | `src/tools/exec.ts` | `-r -f` → `-rf` before denylist |
| Anthropic system prompt | `src/agent/providers/anthropic.ts` | Uses `params.system` properly |
| Config loader async | `src/config/loader.ts`, `src/index.ts` | `reload()` async; `ensureWorkspace()` on `WORKSPACE_ROOT` |
| MemoryTool conditional | `src/tools/index.ts` | Only registers when enabled |

## Unused Dependencies Removed

`js-yaml`, `marked`, `undici`, `@lancedb/lancedb-darwin-x64`, `whatsapp-web.js` — not imported anywhere in source code. `whatsapp-web.js` (and its `fluent-ffmpeg`/`web-streams-polyfill` transitive deps) pulled in system Chromium; its removal cut ~95MB from `node_modules` and ~2GB from the Docker image.

## Removed Dead Code (v2.1 cleanup)

- `src/types/index.ts` — orphaned barrel export (nothing imported it)
- `SnapshotManager.delete/restore` (`src/services/snapshot.ts`)
- `SessionStore.delete/listActive` (`src/db/session-store.ts`)
- `ContextCompressor.estimateMessageTokens/estimateTotalTokens` (`src/services/context-compressor.ts`)
- `VectorStoreManager.isReady/embeddingDimension` getters (`src/services/vector-store/index.ts`)

## Agent Notes

1. **Do not modify** `workspace/config/alfred.json` with real API keys — it's committed as template
2. **Do not install** additional dependencies without evaluating necessity
3. **Preserve** the Provider Factory pattern when adding new LLM providers
4. **Preserve** the `Channel` interface when adding new channels
5. Register new tools in `src/tools/index.ts`
6. **Always compile** (`npx tsc --noEmit`) before finalizing changes
7. **Run tests** (`npm test`) to verify nothing is broken
