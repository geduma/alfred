# Alfred Pennyworth — Personal AI Assistant

Multi-channel, LLM-agnostic AI assistant with persistent personality, web access, file operations, and job scheduling. Runs in a single Docker container.

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd alfred-personal

# 2. Create the workspace directory on your host
#    This will be mounted into the container at /workspace
mkdir -p ~/.alfred-personal/{config,files,db,logs,memory/personality,memory/sessions,memory/jobs}

# 3. Copy configuration templates to the workspace
#    (On first run without these files, Alfred creates them automatically,
#     but pre-copying lets you configure before starting)
cp system/alfred.json.example ~/.alfred-personal/config/alfred.json
cp system/SOUL.md.example ~/.alfred-personal/config/SOUL.md

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
| **WhatsApp** | Scan QR on first start (requires `whatsapp-web.js`) |

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

## Context Compression

Alfred uses a **Sliding Window + Summary** strategy to prevent unbounded context growth. When the conversation history exceeds the token budget, older messages are automatically compressed into a structured summary while the most recent messages are kept verbatim.

- **Token budget**: Configurable via `memory.max_context_tokens` (default: 32,000)
- **Trigger**: Compaction activates at `max_context_tokens × compaction_threshold` (80% by default)
- **Verbatim window**: Last `max_verbatim_messages` (default: 20) preserved exactly
- **Summary format**: Structured sections (DECISIONS, PREFERENCES, PENDING, CONTEXT, KEY_FACTS)
- **Fallback**: If LLM summarization fails, a heuristic extracts key points from recent messages
- **Persistence**: Full history saved to disk; compacted version sent to LLM

Configure in `alfred.json`:
```json
{
  "memory": {
    "max_context_tokens": 32000,
    "max_verbatim_messages": 20,
    "compaction_threshold": 0.8,
    "compaction_model": "auto",
    "summary_sections": ["decisions", "preferences", "pending", "context"]
  }
}
```

## 4 Universal Tools

| Tool | Domain |
|---|---|
| `exec` | Execute shell commands (allowlist/denylist enforced) |
| `file_ops` | Read/write/edit/list files within permitted paths |
| `web` | Web search (DuckDuckGo) and URL content fetch |
| `job` | Schedule one-time and recurring reminders |

## Personality System

- **SOUL.md** — Core identity. Only the user may edit it.
- **preferences.md** — Dynamic preferences (language, tone, style). Managed by Alfred via `file_ops` when you request changes.
- **alfred-rules.md** — Rulebook describing file access permissions, personality protocol, and job protocol. Injected into every system prompt.

Example: _"Respóndeme en español y sé más breve"_ → Alfred adds `language: spanish` and `verbosity: concise` to preferences.md. Every subsequent response follows these preferences.

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
├── gateway.ts                ← WebSocket (port 18789) + session store + job runner + context compressor
├── agent/                    ← LLM router, prompt builder, providers
├── services/
│   └── context-compressor.ts ← Sliding window + summarization for context management
├── tools/                    ← 4 universal tools
├── channels/                 ← Telegram, WhatsApp, CLI
├── db/                       ← SQLite + session persistence (with summary field)
├── security/                 ← Rate limiter, auth
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
# Just say: "Alfred, recarga la configuración"

# From inside the container
docker exec alfred-cli --reload
```

When hot-reload is triggered, Alfred:
1. Re-reads `alfred.json` from disk (validates schema)
2. Re-initializes LLM providers
3. Re-loads SOUL.md
4. Rebuilds the tool registry

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

> **Tip:** Stash `deploy.sh` in a `~/alfred/` directory alongside the repo, or run it from the project root on your Raspberry Pi after SSH'ing in.

## Docs

- `docs/AGENTS.md` — Instructions for AI agents working on the project
- `docs/PRD.md` — Product Requirements Document
- `docs/PROGRESS.md` — Implementation progress
- `system/alfred-rules.md` — Full rulebook injected into system prompts

## License

MIT
