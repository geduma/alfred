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
- **Docker:** node:22-alpine (~180MB)

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
│   ├── vector-store/
│   │   ├── index.ts          ← LanceDB vector store manager (init, ingest, search, delete)
│   │   └── embedder.ts      ← Agnostic embedder factory (Ollama, OpenAI, OpenAI-compatible)
│   └── snapshot.ts           ← Session snapshots for long-term memory checkpoints
├── tools/                    ← 4 universal tools
│   ├── exec.ts               ← Shell with allowlist/denylist
│   ├── file-ops.ts           ← File CRUD with multi-path permission rules
│   ├── web.ts                ← Unified web search + fetch (action: "search" | "fetch")
│   └── job-scheduler.ts      ← Create/list/update/cancel reminders
├── channels/                 ← Communication channels
│   ├── channel-manager.ts
│   ├── telegram.ts           ← Grammy bot
│   ├── whatsapp.ts           ← whatsapp-web.js
│   └── cli.ts                ← Interactive readline
├── db/                       ← Persistence
│   ├── schema.sql            ← 5 tables
│   ├── index.ts              ← Init + migrations
│   ├── session-store.ts      ← Session serialization to workspace/memory/sessions/ (now with summary field)
│   └── repositories/         ← Sessions, Messages, Commands
├── security/
│   ├── rate-limiter.ts       ← Rate limiting by user/channel
│   └── auth.ts               ← Gateway token + ACL
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
- `providers` → Full provider list (each with `type`, `enabled`, `model`, `config`)
- `tools` → Per-tool configuration
- `channels` → Channel + permissions (ACL via `allow_from`)
- `database` → SQLite path + settings
- `memory` → Context compression, prompt compression, vector store, and snapshot settings
- `memory.prompt_compression` → Telegraph English compression (enabled, mode: telegraph|off)
- `memory.vector_store` → LanceDB RAG config (embedding provider, search params, ingest settings)
- `memory.snapshots` → Session snapshot config (auto interval, max per session)
- `security.gateway_auth_token` → Minimum 16 characters

## 4 Universal Tools

| Tool | File | Domain |
|---|---|---|
| `exec` | `src/tools/exec.ts` | Shell commands with allowlist/denylist |
| `file_ops` | `src/tools/file-ops.ts` | Read/write/edit/delete/list files in permitted paths |
| `web` | `src/tools/web.ts` | Web search (DuckDuckGo) and URL fetch (cheerio) |
| `job` | `src/tools/job-scheduler.ts` | CRUD reminders, persisted to workspace/memory/jobs/ |

## Personality System

- **SOUL.md** (`workspace/config/SOUL.md`) — Core identity, user-editable only
- **preferences.md** (`workspace/memory/personality/preferences.md`) — Dynamic preferences managed by the LLM via `file_ops`
- **alfred-rules.md** (`config/alfred-rules.md`) — File access rules + personality protocol + job protocol, injected into system prompt
- The LLM reads/writes `preferences.md` when the user requests behavior changes (language, tone, formality, etc.)

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

- **Embedding**: Agnostic — supports Ollama (local), OpenAI, and any OpenAI-compatible API
- **Provider reference**: Can reuse an existing LLM provider's `api_url`/`api_key` via `provider_ref`
- **Ingest**: Every user message, tool response, and assistant reply is embedded and stored
- **Search**: On each query, Alfred retrieves top-K semantically similar chunks from past sessions
- **Injection**: Results are injected as `[RAG CONTEXT — Retrieved from long-term memory]` messages
- **Config**: `memory.vector_store` in alfred.json (embedding provider, paths, search params)

Key implementation files:
- `src/services/vector-store/index.ts` — LanceDB init, ingest, search, delete
- `src/services/vector-store/embedder.ts` — Agnostic embedder factory

### Embedding Examples

```json
// Using local Ollama via provider_ref
"embedding": { "type": "openai-compatible", "model": "nomic-embed-text", "dimension": 768, "provider_ref": "ollama-local" }

// Using OpenAI API directly
"embedding": { "type": "openai", "model": "text-embedding-3-small", "dimension": 1536, "config": { "api_key": "sk-..." } }

// Using custom OpenAI-compatible endpoint
"embedding": { "type": "openai-compatible", "model": "bge-m3", "dimension": 1024, "config": { "api_url": "http://192.168.1.100:11434/v1" } }
```

## Snapshots

Snapshots are point-in-time session checkpoints for long-term memory recall:

- **Auto-snapshot**: Creates a snapshot every N messages (`auto_snapshot_interval`, default: 50)
- **Manual**: Programmatic via SnapshotManager API (future tool integration)
- **Pruning**: Oldest snapshots are auto-deleted when exceeding `max_snapshots_per_session`
- **Storage**: JSON files in `workspace/memory/snapshots/`
- **Integration**: Snapshots tag vectors in LanceDB for cross-session search filtering
- **Config**: `memory.snapshots` in alfred.json (enabled, interval, max)

The snapshot pipeline in `prepareContext()` runs after each successful interaction, checking the message counter against the configured interval.

## Auto-Created Configs

On first startup, if `workspace/config/alfred.json` or `workspace/config/SOUL.md` don't exist, they are auto-created from:
- `config/alfred.json.example`
- `config/SOUL.md.example`

The user is prompted to edit these files with real API keys.

## Testing

- Unit tests in `tests/unit/`
- Jest with `ts-jest`
- Run: `npm test`

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

## Agent Notes

1. **Do not modify** `workspace/config/alfred.json` with real API keys — it's committed as template
2. **Do not install** additional dependencies without evaluating necessity
3. **Preserve** the Provider Factory pattern when adding new LLM providers
4. **Preserve** the `Channel` interface when adding new channels
5. Register new tools in `src/tools/index.ts`
6. **Always compile** (`npx tsc --noEmit`) before finalizing changes
7. **Run tests** (`npm test`) to verify nothing is broken
