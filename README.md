# Alfred Pennyworth — Personal AI Assistant

Multi-channel, LLM-agnostic AI assistant with persistent personality, web access, file operations, and job scheduling. Runs in a single Docker container.

## Requirements

- **Docker** with **Compose v2** (`docker compose`, not the legacy `docker-compose` v1)
- **64-bit Linux (arm64 or x86_64)**. On Raspberry Pi: use the **64-bit OS** (e.g. Raspberry Pi OS Lite 64-bit) — the LanceDB vector store only ships `arm64` binaries, so 32-bit systems (armv7 / RPi 3) will fail to start with the vector store enabled. If you must run 32-bit, set `memory.vector_store.enabled` to `false` and `memory.snapshots.enabled` to `false`.
- **RAM/swap**: building the image runs `npm ci` + `tsc`; on a Pi 4/5 with 4GB this is fine, on 2GB systems add at least 2GB of swap (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`).
- First build takes several minutes (downloads npm packages).

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd alfred-personal

# 2. Create the workspace directory on your host
#    This will be mounted into the container at /workspace
#    (skills/ dirs are auto-created on first startup if missing)
mkdir -p ~/.alfred-personal/{config,files,db,logs,memory/{personality,sessions,jobs,vectors,snapshots}}

# 3. Copy configuration templates to the workspace
#    (On first run without these files, Alfred creates them automatically,
#     but pre-copying lets you configure before starting)
cp system/alfred.json.example ~/.alfred-personal/config/alfred.json
cp system/SOUL.md.example ~/.alfred-personal/config/SOUL.md
cp system/secrets.env.example ~/.alfred-personal/config/secrets.env

# 4. Edit the configuration with your API keys
#    Required: LLM provider (api_key, api_url) and Telegram bot_token
vim ~/.alfred-personal/config/alfred.json

# 5. Build and start the container
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d

# 6. Check the logs to verify startup
docker compose -f docker/docker-compose.yml logs -f alfred

# 7. Access the interactive CLI channel
docker attach alfred-agent

# 8. Send a test message from Telegram or type in the CLI
#    Alfred will respond using the configured LLM
```

> **Permission note:** the container runs as the `node` user (UID 1000). On Raspberry Pi OS the default user is also UID 1000, so `~/.alfred-personal` works out of the box. If your user has a different UID, run `sudo chown -R 1000:1000 ~/.alfred-personal` after creating the directory.

### Development Mode (without Docker)

```bash
npm install
npm run dev
```

> **Note:** The config file (`workspace/config/alfred.json`) can use `/workspace/...` paths — Alfred resolves them to `./workspace/...` locally. Set `WORKSPACE=./custom-path` to use a different data directory.

## Channels

| Channel | Access |
|---|---|
| **CLI** | `docker attach alfred-agent` (Docker) or runs in terminal (`npm run dev`) |
| **Telegram** | Chat with your bot after setting `bot_token` in config |
| **Web** | Open `http://YOUR_HOST:18789` — web UI + live updates over `/ws`. No auth in this phase (see TODO in `src/gateway.ts`); runs on the same HTTP server as the main WS (port from `server.port`, default 18789) |

## Configuration

Single file: `~/.alfred-personal/config/alfred.json` (Docker) or `workspace/config/alfred.json` (local dev).

### `WORKSPACE` environment variable

Alfred auto-detects the workspace root:
- **Docker**: set to `/workspace` in docker-compose — all paths in `alfred.json` resolve under this.
- **Local**: defaults to `./workspace` (inside the project directory).
- **Override**: set `WORKSPACE=/path/to/data` to point anywhere.

The config file paths (`database.path`, `logging.file_path`, `agent.personality_file`) all resolve relative to `WORKSPACE`. You can keep using `/workspace/...` paths in the config file — Alfred automatically rewrites them to the actual workspace root.

```json
{
  "llm": {
    "primary_provider": "ollama-runpod",
    "fallback_providers": ["ollama-local", "anthropic"]
  },
  "providers": {
    "ollama-runpod": {
      "type": "openai-compatible",
      "enabled": true,
      "model": "mistral-large",
      "config": {
        "api_url": "https://api.runpod.io/v1/YOUR_ID/openai/v1",
        "api_key": "YOUR_KEY"
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "type": "telegram",
      "config": { "bot_token": "YOUR_TOKEN" },
      "permissions": { "allow_from": ["YOUR_USER_ID"] }
    }
  }
}
```

On first startup, if the config doesn't exist, it's auto-created from `system/alfred.json.example`. The `gateway_auth_token` is also auto-generated if set to `CHANGE_ME`.

### Spending limits

Optional section — if absent, spending control is disabled (v2.1 behavior unchanged). Token usage is persisted per request and checked against daily/monthly caps:

```json
{
  "spending_limits": {
    "enabled": true,
    "warn_threshold": 0.8,
    "on_limit_reached": "block_paid_providers",
    "daily_tokens": 500000,
    "monthly_tokens": 10000000
  }
}
```

Providers can be marked `"paid": true` so `block_paid_providers` excludes only the paid ones from the fallback chain. When the budget is exhausted the gateway replies with a degraded message, warns you (Telegram/web) at the threshold, and Alfred can report the budget via the `health` tool (`health budget` / `health status`). If remaining usage drops below 20%, context compaction is tightened for that request.

### Web server

```json
{
  "server": { "port": 18789, "host": "0.0.0.0" }
}
```

Optional; defaults `18789` / `0.0.0.0`. Serves the web UI and the WebSocket channels.

## Memory System

Alfred uses a three-layer memory system to manage context efficiently across sessions.

### Layer 1: Context Compression (Sliding Window)

Prevents unbounded context growth within a single session. When the conversation history exceeds the token budget, older messages are automatically compressed into a structured summary while the most recent messages are kept verbatim.

- **Token budget**: Configurable via `memory.max_context_tokens` (default: 32,000)
- **Trigger**: Compaction activates at `max_context_tokens × compaction_threshold` (80% by default)
- **Verbatim window**: Last `max_verbatim_messages` (default: 20) preserved exactly
- **Summary format**: Structured sections (DECISIONS, PREFERENCES, PENDING, CONTEXT, KEY_FACTS)
- **Fallback**: If LLM summarization fails, a heuristic extracts key points from recent messages
- **Persistence**: Full history saved to disk; compacted version sent to LLM

### Layer 2: Prompt Compression (Telegraph English)

Reduces the system prompt size by 20-45% before every LLM call using pure-TypeScript rule-based compression (removes articles, fillers, auxiliary verbs, shortens phrases).

- **Zero external dependencies**: No Python, no models, no API calls
- **Latency**: <10ms per request
- **Config**: `memory.prompt_compression` in alfred.json

### Layer 3: Vector Store (RAG) with LanceDB

Provides cross-session semantic memory via vector search. Every message is embedded locally using a zero-dependency hashing vectorizer (no ML models, no external APIs); before each response, Alfred retrieves the most relevant chunks from past conversations.

- **Embedding provider**: Built-in hashing vectorizer — zero dependencies, zero downloads, zero cost. Uses word frequency hashing with L2 normalization.
- **Dimension**: 256 (configurable) — tiny vectors, fast cosine similarity
- **Latency added**: ~5μs (search + embedding), offset by 2-4s LLM savings from smaller prompts
- **Token reduction**: ~46% vs non-RAG sliding window approach

### Snapshots

Automatic session checkpoints every N messages for long-term memory recall. Snapshots tag vectors in LanceDB, enabling filtering by point-in-time.

### Full Memory Config

```json
{
  "memory": {
    "max_context_tokens": 32000,
    "max_verbatim_messages": 20,
    "compaction_threshold": 0.8,
    "compaction_model": "auto",
    "summary_sections": ["decisions", "preferences", "pending", "context"],
    "prompt_compression": {
      "enabled": true,
      "mode": "telegraph",
      "aggressive": false
    },
    "vector_store": {
      "enabled": true,
      "type": "lancedb",
      "path": "/workspace/memory/vectors",
      "embedding": {
        "type": "hashing",
        "dimension": 256
      },
      "ingest": { "on_message": true, "max_chunk_size": 512 },
      "search": { "top_k": 5, "min_score": 0.5 }
    },
    "snapshots": {
      "enabled": true,
      "auto_snapshot_interval": 50,
      "max_snapshots_per_session": 20
    }
  }
}
```

### Layer 4: Health Monitor

Periodically scans application logs for errors and warnings, categorizes them, and sends alerts via Telegram.

- **Log scanner**: Reads `alfred.log` from last known position, parses JSON entries, filters by severity
- **Categories**: `vector_store`, `llm_provider`, `telegram`, `database`, `tool_execution`, `session`, `snapshot`, `job_scheduler`, `other`
- **Alert delivery**: Telegram (configurable `chat_id`), with email-ready architecture
- **Interval**: Configurable via `health_monitor.check_interval_minutes` (default: 60 min)
- **LLM-accessible**: The `health` tool lets Alfred respond to queries like _"health findings"_ or _"trigger a health check now"_
- **Stateful**: Tracks last scanned byte position across restarts

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

## Universal Tools

| Tool | Domain |
|---|---|
| `exec` | Execute shell commands (allowlist/denylist enforced) |
| `file_ops` | Read/write/edit/list files within permitted paths |
| `web` | Web search (DuckDuckGo) and URL content fetch |
| `job` | Schedule one-time and recurring reminders |
| `system` | Health/status/reload delegated to the gateway |
| `health` | Health monitor + token budget + circuit states — `status`/`budget`/`findings`/`check`/`configure` |
| `memory` | Conditional — vector search + snapshots (registered only when the memory system is enabled) |

## Personality System

- **SOUL.md** — Core identity. Only the user may edit it.
- **preferences.md** — Dynamic preferences (language, tone, style). Managed by Alfred via `file_ops` when you request changes.
- **alfred-rules.md** — Rulebook describing file access permissions, personality protocol, skill implementation protocol, and secrets management protocol. Injected into every system prompt.

Example: _"Respond in English and be more concise"_ → Alfred adds `language: english` and `verbosity: concise` to preferences.md. Every subsequent response follows these preferences.

## Skills & Secrets

Alfred can implement new functionality as **SKILL.md** files in `/workspace/skills/custom/` — markdown documents that instruct Alfred how to orchestrate his tools (`exec`, `file_ops`, `web`, `job`, `system`) to fulfill a task.

On first startup Alfred auto-copies bundled skills from `system/skills-custom/` (daily-digest, weekly-review, system-check — instructions in Spanish) into `/workspace/skills/custom/` without overwriting existing files.

**Skill credentials** (API keys, tokens, passwords) are stored separately in `workspace/config/secrets.env` — never hardcoded in the SKILL.md. This file is auto-created from a template on first startup.

- Alfred **reads** secrets when executing skills, but **never modifies** them
- To add a credential: edit `secrets.env` manually, then ask Alfred to use the skill
- Provider API keys remain in `alfred.json` (not in secrets.env)

See `system/alfred-rules.md` → "Skill Implementation Protocol" and "Secrets Management Protocol" for the full rules.

## LLM Agnostic

Switch providers by editing `alfred.json`:

```json
{
  "llm": {
    "primary_provider": "anthropic",
    "fallback_providers": ["ollama-local"]
  }
}
```

Supported: OpenAI-compatible (Ollama, RunPod, LocalAI), Anthropic Claude, OpenAI, Google Gemini. Automatic fallback if the primary provider fails.

## Architecture

```
src/
├── index.ts                  ← Entry point
├── gateway.ts                ← WebSocket + session store + job runner + context compressor + RAG + prompt compression + health monitor
├── agent/                    ← LLM router, prompt builder, providers
├── services/
│   ├── context-compressor.ts ← Sliding window + summarization for context management
│   ├── prompt-compressor.ts  ← Telegraph English rule-based compression
│   ├── token-budget.ts       ← Token budget + spending limits (daily/monthly, paid gating)
│   ├── vector-store/         ← LanceDB vector store + agnostic embedder
│   ├── snapshot.ts           ← Session checkpoints
│   ├── health-monitor.ts     ← Log scanner + alert generator
│   └── notification.ts      ← Alert delivery (Telegram)
├── tools/                    ← Universal tools (exec, file_ops, web, job, system, health + conditional memory)
├── channels/                 ← Telegram, CLI, Web (push-only)
├── db/                       ← SQLite (embedded schema + token_usage_log) + session persistence (with summary field)
├── security/                 ← Rate limiter
└── types/                    ← TypeScript interfaces
```

## Deployment

### Docker (Recommended)

```bash
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml logs -f alfred
docker attach alfred-agent    # Access the CLI channel
```

Volume mapping: `~/.alfred-personal` on the host → `/workspace` inside the container. All data persists across restarts.

> **Image note:** the build runs `npm ci` in both stages (with dev deps only in the builder) and cleans the npm cache in the final stage (`npm cache clean --force`) so `/root/.npm` doesn't ship in the image. The WhatsApp channel (whatsapp-web.js + system Chromium) was removed entirely — the image is estimated at ~0.5-1.0 GB instead of ~2.5 GB. Confirm with `docker compose build --no-cache` + `docker history --no-trunc`.
>
> **Dependency note:** the `sqlite3` package is functional but its upstream repo (`node-sqlite3`) was archived in 2026. Consider migrating to a maintained alternative in a future release.

### Local Development

```bash
npm install
npm run dev      # Hot-reload with tsx watch
npm run build    # Production build
npm start        # Run compiled version
npm test         # Run tests
```

## Updates & Deployment

There are two levels of changes, each with its own update path:

### Level 1: Configuration & Data (no restart needed)

Files on the `~/.alfred-personal` volume are read from disk on every request — **no restart required**:

| File | How to update |
|---|---|
| `~/.alfred-personal/config/alfred.json` | Edit the file, then trigger a hot-reload (see below) |
| `~/.alfred-personal/config/SOUL.md` | Edit the file, then trigger a hot-reload |
| `~/.alfred-personal/memory/personality/preferences.md` | Alfred manages it via `file_ops` — just tell Alfred what you want |
| `~/.alfred-personal/files/*` | Read/written by Alfred via `file_ops` tool |

**Hot-reload** applies config and personality changes without restarting the container:

```bash
# Via WebSocket (from any machine with the auth token)
echo '{"type":"req","id":"r1","method":"reload","params":{}}' | websocat ws://YOUR_HOST:18789

# Via Alfred's system tool (in any channel)
# Just say: "Alfred, reload the configuration"

# From inside the container
docker exec alfred-cli --reload
```

When hot-reload is triggered, Alfred:
1. Re-reads `alfred.json` from disk (validates schema)
2. Re-initializes LLM providers
3. Re-loads SOUL.md
4. Updates context compressor, prompt compressor, and tool registry

### Level 2: Code changes (requires rebuild)

When you modify TypeScript source, `system/`, or `docker/Dockerfile`:

```bash
# Quick deploy (git pull + build + restart)
./deploy.sh

# Or manually:
git pull
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d --force-recreate
```

The volume `~/.alfred-personal` persists across rebuilds — your config, database, files, and logs are never lost.

### deploy.sh

A convenience script that automates the full code deployment cycle:

```bash
./deploy.sh
```

Steps performed:
1. `git pull` — fetches latest code from the repository
2. `docker compose build` — rebuilds the image with new code
3. `docker compose up -d --force-recreate` — replaces the running container
4. `docker image prune -f` — cleans up old images
5. Post-deploy healthcheck — probes port 18789 (`nc -z localhost 18789`), waits up to `HEALTH_WAIT_SECONDS` (default 60) for the gateway, and exits 1 with the container logs if it never comes up

> **Tip:** Stash `deploy.sh` in a `~/alfred/` directory alongside the repo, or run it from the project root on your Raspberry Pi after SSH'ing in.

## Recent Improvements (v2.2)

### Spending Control & Cost Awareness
- **Real spend tracking**: per-request token usage persisted in SQLite (`token_usage_log`, `TokenUsageRepository`) with daily/monthly sums per provider (`ProviderUsageSummary` incl. `is_paid`)
- **Spending limits**: optional `spending_limits` section (`enabled` default `false`, `warn_threshold` 0.8, `on_limit_reached` default `block_paid_providers`); `BudgetBlockedError` + degraded replies when exhausted. Absent section = v2.1 behavior (disabled)
- **Paid-provider gating**: `paid: true` on a provider lets `block_paid_providers` exclude paid ones from the fallback chain
- **Budget alerts**: `warn` notification (Telegram/web) when remaining crosses the threshold; deduped per period
- **Context override**: remaining < 20% → compaction threshold forced to 0.6 for that request
- **Health tool budget**: `health status` / `health budget` expose allowance, remaining %, and per-provider usage

### Web Channel
- **Web UI**: static frontend in `web/` (chat + config editor) served by the gateway HTTP server
- **WebSocket routing**: `/ws` → web client (no auth yet — explicit TODO), root → main WS with auth token; same port (`server.port`, default 18789)
- **Config via WS**: `config_get` (secrets sanitized as `*****`) and `config_update` (deep merge + persist, needs reload)
- **Live updates**: web clients receive message broadcasts via `WebChannel`; `agent_complete` events drive the chat UI

### Daily Life Agent
- **Bundled skills**: `daily-digest`, `weekly-review`, `system-check` (Spanish) in `system/skills-custom/`, auto-copied to `workspace/skills/custom/` on first startup (copy-if-missing); `SkillLoader` now also scans the custom subdir

### Ops & Resilience (no breaking changes)
- **Healthcheck**: `deploy.sh` probes the gateway port post-deploy (`nc -z`, `HEALTH_WAIT_SECONDS` default 60, exits 1 with logs on failure)
- **Provider agnosticism kept**: no code references any specific vendor; routing/cost/cache strategies remain documentation-only

## Recent Improvements (v2.1)

### Simplification & Cleanup
- **WhatsApp channel removed**: `whatsapp-web.js`, its ~95MB dependency subtree, and system Chromium are gone from the repo, Dockerfile, and config. Channels are now Telegram + CLI only. Estimated Docker image drops from ~2.5 GB to ~0.5-1.0 GB (rebuild on the deploy host to confirm).
- **Dead code removed**: `src/types/index.ts` barrel (orphaned), `SnapshotManager.delete/restore`, `SessionStore.delete/listActive`, `ContextCompressor.estimateMessageTokens/estimateTotalTokens`, and unused `VectorStoreManager` getters.
- **Build script**: `npm run build` now runs `rm -rf dist && tsc` (no stale artifacts).
- **Dockerfile**: `npm cache clean --force` in the final stage.

### Performance & Security
- **Concurrency control**: Tool execution batches (max 3 concurrent) with 60s per-tool timeout (`src/gateway.ts`)
- **Circuit breaker jitter**: ±30% jitter on reset timeout to prevent thundering herd (`src/services/circuit-breaker.ts`)
- **SQLite WAL tuning**: `wal_autocheckpoint=1000` for better write performance (`src/db/index.ts`)
- **SAFETY_MULTIPLIER reduced**: 1.3 → 1.15 for tighter token budget (`src/utils/token-counter.ts`)
- **Shutdown timeout**: 10s graceful shutdown (`src/gateway.ts`)
- **Token budget tracking**: Integrated `TokenBudgetTracker` into `LLMRouter`, accessible via `getTokenUsage()` (`src/services/token-budget.ts`)
- **Secrets filtering universal**: `filterSecrets()` applies to ALL file reads, not just `alfred.json`/`.env` (`src/tools/file-ops.ts`)
- **exec anti-evasion**: `normalizeCommandFlags()` fuses adjacent flags (`-r -f` → `-rf`) before denylist check (`src/tools/exec.ts`)

### Code Quality
- **Unused dependencies removed**: `js-yaml`, `marked`, `undici`, `@lancedb/lancedb-darwin-x64` (3 packages, 0 impact on functionality)
- **Anthropic provider fix**: System prompt uses `params.system` instead of first user message (`src/agent/providers/anthropic.ts`)
- **Config loader async**: `reload()` async; `ensureWorkspace()` writes to `WORKSPACE_ROOT` (`src/config/loader.ts`, `src/index.ts`)
- **MemoryTool conditional**: Only registered when memory system is enabled (`src/tools/index.ts`)

### Accepted Findings (not corrected)
| Finding | Reason |
|---------|--------|
| Timing attack on auth token | Localhost/Docker only — impractical to exploit |
| API keys in plaintext on disk | Conscious trade-off for simplicity in isolated Docker |
| SSRF DNS rebinding | Low risk in Docker, complex to mitigate |
| No channel auth (beyond ACL) | By design — ACL whitelist is sufficient |
| exec parseCommand rudimentary | Acceptable for current use cases |
| Hashing embedder (no semantics) | Intentional — zero-dependency, low-power design |
| Docker image not optimized | Future improvement (multi-stage lite) |

## Docs

- `docs/AGENTS.md` — Instructions for AI agents working on the project
- `docs/PRD.md` — Product Requirements Document
- `docs/PROGRESS.md` — Implementation progress
- `system/alfred-rules.md` — Full rulebook injected into system prompts

## Author

**geduma** — [geduma.com](https://geduma.com)

## License

MIT
