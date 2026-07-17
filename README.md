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

## Channels

| Channel | Access |
|---|---|
| **CLI** | `docker attach alfred-agent` (Docker) or runs in terminal (`npm run dev`) |
| **Telegram** | Chat with your bot after setting `bot_token` in config |
| **WhatsApp** | Scan QR on first start (requires `whatsapp-web.js`) |

## Configuration

Single file: `~/.alfred-personal/config/alfred.json` (or `workspace/config/alfred.json`)

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
├── gateway.ts                ← WebSocket (port 18789) + session store + job runner
├── agent/                    ← LLM router, prompt builder, providers
├── tools/                    ← 4 universal tools
├── channels/                 ← Telegram, WhatsApp, CLI
├── db/                       ← SQLite + session persistence
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

## Docs

- `docs/AGENTS.md` — Instructions for AI agents working on the project
- `docs/PRD.md` — Product Requirements Document
- `docs/PROGRESS.md` — Implementation progress
- `system/alfred-rules.md` — Full rulebook injected into system prompts

## License

MIT
