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
│   └── context-compressor.ts ← Sliding window + LLM summarization for context management
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
- `memory` → Context compression settings (max_context_tokens, max_verbatim_messages, compaction_threshold, etc.)
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
