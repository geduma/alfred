# ALFRED — Quick Start Guide

**Version:** 2.2.0  
**For:** The user  

---

## 30 SECONDS

**Alfred** is your personal AI assistant that:
- Communicates via Telegram, CLI, and web
- Reads and writes your files
- Searches the internet
- Understands your tone (SOUL.md)
- Uses any LLM (Ollama cloud, Anthropic, OpenAI, etc.)
- Everything in ONE Docker container

---

## SETUP (5 MINUTES)

```bash
# 1. Clone
git clone https://github.com/yourusername/alfred-personal.git
cd alfred-personal

# 2. Create workspace
mkdir -p ~/.alfred-personal/{config,files,db,logs,memory/{personality,sessions,jobs,vectors,snapshots}}

# 3. Copy templates (edit with your API keys + Telegram token)
cp system/alfred.json.example ~/.alfred-personal/config/alfred.json
cp system/SOUL.md.example ~/.alfred-personal/config/SOUL.md
cp system/secrets.env.example ~/.alfred-personal/config/secrets.env
vim ~/.alfred-personal/config/alfred.json

# 4. Build and run (Docker Compose v2)
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d

# 5. Check logs
docker compose -f docker/docker-compose.yml logs -f alfred
```

---

## MINIMUM CONFIGURATION

Edit `~/.alfred-personal/config/alfred.json`:

```json
{
  "llm": {
    "primary_provider": "ollama-runpod"
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
      "config": {
        "bot_token": "YOUR_BOT_TOKEN"
      },
      "permissions": {
        "allow_from": ["YOUR_USER_ID"]
      }
    }
  }
}
```

**That's it!** Everything else is auto-configured.

---

## WHAT CAN YOU DO?

### Immediate
✅ Chat via Telegram  
✅ Questions (Alfred searches the internet)  
✅ Read/write files in `/workspace/files/`  
✅ Execute shell commands  
✅ Web UI at `http://YOUR_HOST:18789`

### v1.5
✅ Custom skills — SKILL.md via `file_ops`

### v2.0
✅ Embeddings + semantic search (LanceDB RAG)  
✅ Health monitor — automatic failure detection and Telegram alerts  

### v2.2
✅ Token spending limits — daily/monthly budgets with paid-provider gating  
✅ Daily digest, weekly review, and system check skills  
✅ Web channel with chat + live metrics dashboard (auto-refresh over WebSocket)

### Roadmap
❌ Discord/Slack — roadmap (not implemented)  
❌ Voice calls — roadmap (not implemented)

---

## SWITCHING LLM

Want to switch from Ollama to Anthropic?

```json
{
  "llm": {
    "primary_provider": "anthropic"
  },
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "enabled": true,
      "model": "claude-3-5-sonnet-20241022",
      "config": {
        "api_key": "sk-ant-XXX"
      }
    }
  }
}
```

Restart Alfred. **That's it.**

---

## PERSONALITY (SOUL.md)

Your assistant always responds as Alfred:
- English
- Elegant and precise
- Addresses you as "Mr. [user_name]"
- Refined but direct

Edit `/workspace/config/SOUL.md` to change it.

---

## IMPORTANT FILES

```
~/.alfred-personal/
├── config/
│   ├── alfred.json        ← Main configuration
│   ├── SOUL.md            ← Alfred's personality
│   ├── secrets.env        ← Secrets for skills (IMAP, APIs, etc.)
│
├── files/                 ← Your files (readable/writable)
├── skills/
│   └── custom/            ← Custom skills (SKILL.md)
├── db/
│   └── alfred.db          ← Database (conversations, audit, token usage)
└── logs/                  ← Audit logs
```

---

## MONITORING

```bash
# Watch logs in real time
docker compose -f docker/docker-compose.yml logs -f alfred

# Container status
docker compose -f docker/docker-compose.yml ps

# Resource statistics
docker stats alfred

# Connect to the DB
sqlite3 ~/.alfred-personal/db/alfred.db

# Verify configuration
cat ~/.alfred-personal/config/alfred.json | jq
```

### Automatic Health Monitor

Alfred scans its own logs every 60 minutes. If it detects repeated errors, it sends an alert via Telegram.

**Available commands** (via Telegram, CLI, or web):
- `health findings` — see all recent findings
- `health findings severity=error` — only critical errors
- `health check` — force an immediate scan
- `health status` — monitor status
- `health budget` — token spending status

---

## TROUBLESHOOTING

| Problem | Solution |
|----------|----------|
| WebSocket error | `docker compose -f docker/docker-compose.yml logs alfred` |
| Provider won't connect | Check the API key in alfred.json |
| Telegram not responding | Check bot_token and allow_from |
| File not created | Check permissions in `/workspace/files` |
| Vector store fails | Make sure there is enough RAM or disable `memory.vector_store.enabled: false` |
| Health alert without message | Check `health_monitor.severity_threshold` — with `"warn"` it catches everything, with `"error"` only critical |

---

## FULL DOCUMENTATION

The technical documentation lives in the repository:

- `README.md` — Getting started, setup, architecture, and deployment
- `docs/PRD.md` — Product requirements
- `docs/AGENTS.md` — Instructions for AI agents / developers
- `system/alfred-rules.md` — Rules injected into the system prompt

---

## NEXT STEPS

1. ✅ Initial setup (above)
2. 📝 Customize `SOUL.md` if you wish
3. 💬 Send a message via Telegram
4. 🎯 Alfred responds as your personal assistant
5. 🚀 Add skills/plugins as you need them

---

**Ready to get started?**

Start with `README.md` and `docs/AGENTS.md` — they contain everything you need to know.
