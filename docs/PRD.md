# PRD — Product Requirements Document

## Alfred — Multi-channel Personal AI Agent

**Version:** 2.1.0  
**Date:** July 2026  
**Status:** Implemented

---

## 1. Executive Summary

Alfred is a personal AI assistant that works as a decentralized multi-channel gateway. It lets the user interact with language models (LLMs) through Telegram, CLI, and web, with a persistent personality, internet access, and tool execution, all in a single Docker container.

## 2. Problem

The user needs an AI assistant that:
- Is multi-channel (Telegram, CLI, web)
- Can switch LLMs without modifying code
- Has a consistent personality
- Accesses the internet for up-to-date information
- Executes commands and manipulates files locally
- Is 100% self-managed and open-source
- Runs in a single Docker container

## 3. Product Vision

A personal AI agent with a personality (SOUL.md) that operates as a digital butler, accessible from any messaging channel, with the ability to execute tasks, search for information, and maintain context, all configured from a single JSON file.

## 4. Technical Stack

| Component | Specification |
|---|---|
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5.4+ |
| Database | Embedded SQLite3 |
| WebSocket | ws@8.17 |
| Logging | pino@8.18 |
| Validation | zod@3.22 |
| Testing | Jest + ts-jest |
| Docker | node:22-alpine, multi-stage build |
| Image size | ~0.5-1.0 GB (base node:22-alpine ~180MB; WhatsApp/Chromium removed) |

## 5. Functional Features

### F5.1 Centralized Configuration
- **ID:** F-CONFIG-001
- **Description:** Everything is configured from a single `alfred.json` file
- **Validation:** Zod schema at startup
- **Coverage:** LLM providers, channels, tools, security, database, logging

### F5.2 LLM Agnostic
- **ID:** F-LLM-001
- **Description:** Supports multiple providers without changing code
- **Providers:** openai-compatible (Ollama, RunPod, LocalAI), Anthropic, OpenAI, Gemini
- **Fallback:** Automatic chain if the primary provider fails
- **Config:** `llm.primary_provider` + `llm.fallback_providers`

### F5.3 Persistent Personality (SOUL.md)
- **ID:** F-SOUL-001
- **Description:** A Markdown file defines tone, values, limits, and behavior
- **Injection:** Loaded in every interaction as part of the system prompt
- **Language:** Always English by default
- **Address:** "Mr. [user_name]" (dynamic from preferences.md)

### F5.4 WebSocket Gateway
- **ID:** F-GW-001
- **Description:** Central WebSocket hub (port 18789)
- **Protocol:** JSON-RPC-like (req/res/event)
- **Auth:** Gateway token
- **Functions:** connect, agent, skill_list, tool_list, metrics

### F5.5 Multi-channel Channels
- **ID:** F-CH-001
- **Description:** Multiple communication channels
- **v1.0:** Telegram (grammy), CLI (readline)
- **v2.0:** Discord, Slack
- **v2.2:** Web (web UI + push WebSocket on /ws)
- **ACL:** Per-channel user whitelist

### F5.6 Tools
- **ID:** F-TOOL-001
- **Description:** Set of tools executable by the LLM

| Tool | Purpose | Security |
|---|---|---|
| exec | Shell commands | Allowlist/denylist, timeout, env sanitization |
| file_ops | File CRUD | Confined to /workspace/files, max 100MB |
| web | Web search + fetch (unified) | DuckDuckGo, timeout, HTML cleanup |
| job | One-time/recurring reminders | Persisted in workspace/memory/jobs/ |
| system | Health/status/reload | Delegated to the gateway |
| health | Health monitor findings + budget + circuit states | Read-only + on-demand check |
| memory | Vector search + snapshots (conditional) | Enabled only with the memory system active |

### F5.7 SQLite Persistence
- **ID:** F-DB-001
- **Description:** Embedded SQLite database
- **Tables:** sessions, messages, command_log, user_context, skills_cache, token_usage_log
- **Features:** WAL mode, foreign keys, auto-migration

### F5.8 Context Compression
- **ID:** F-MEM-001
- **Description:** Intelligent context management to avoid unbounded growth
- **Strategy:** Sliding window + LLM summarization
- **Compression:** Older messages are compressed into a structured summary with sections: DECISIONS, PREFERENCES, PENDING, CONTEXT, KEY_FACTS
- **Threshold:** Configurable via `memory.max_context_tokens` (default: 32000) and `memory.compaction_threshold` (default: 0.8)
- **Adaptive:** On a 413/request-too-large error, Alfred learns the provider's real limit and persists it to `workspace/memory/provider-budgets.json`, compacts and retries (up to 3 cycles, then once without tools). No model-specific hardcoded values; `provider.config.max_context_tokens` is an optional manual override
- **Output:** `max_tokens` per call is derived from the effective budget (`max(512, budget × 0.35)`), capped by the configured `max_tokens`
- **Verbatim:** The last N messages are kept intact (`max_verbatim_messages`, default: 20)
- **Persistence:** Full history on disk, compacted version sent to the LLM
- **Fallback:** If the LLM does not generate a summary, a heuristic based on recent messages is used

### F5.8 Modular Skills (v1.5)
- **ID:** F-SKILL-001
- **Description:** Skills defined in SKILL.md with YAML frontmatter
- **Loading:** No recompilation, from /workspace/skills/
- **Discovery:** Automatic via skill_loader tool
- **Secrets:** Credentials are stored in `workspace/config/secrets.env` (auto-created from template), never in the SKILL.md
- **Protocol:** Documented in `system/alfred-rules.md` → "Secrets Management Protocol"

### F5.9 Secrets Management (v2.0)
- **ID:** F-SECRETS-001
- **Description:** Credential management for skills (API keys, tokens, passwords)
- **Storage:** `workspace/config/secrets.env` in KEY=VALUE format
- **Permissions:** Read-only for Alfred (via file_ops → `/workspace/config` = `r`)
- **Template:** `system/secrets.env.example` is auto-created on first startup
- **Access:** Alfred reads the file when executing a skill and passes secrets to the `exec` tool via the `env` parameter (sanitized from logs)
- **Usage:** The user manages the file manually; Alfred notifies which variables it needs

### F5.10 Security
- **ID:** F-SEC-001
- **Description:** Layered security
- **Layers:** Gateway auth, tool policy, channel ACL, file confinement, audit logging, rate limiting, secrets isolation

## 6. Non-Functional Requirements

| ID | Requirement | Metric |
|---|---|---|
| NFR-001 | LLM agnostic | No provider-specific code |
| NFR-002 | Single container | Docker with embedded SQLite |
| NFR-003 | 100% open-source | Stack with no license cost |
| NFR-004 | Response time | <30s per request (including LLM) |
| NFR-005 | Horizontally scalable | Distributed sessions via Redis (v2.0) |
| NFR-006 | Type-safe | TypeScript strict + Zod runtime |
| NFR-007 | Resilient | Automatic provider fallback |
| NFR-008 | Auditable | All commands logged in SQLite |

## 7. User Stories

### US-001: Conversation via Telegram
> As a user, I want to chat with Alfred via Telegram to get quick answers.

**Acceptance criteria:**
- Message in Telegram → Alfred responds in <30s
- SOUL.md personality is maintained
- Alfred can search the internet if necessary

### US-002: LLM switching
> As a user, I want to change the LLM model by editing a file, not code.

**Acceptance criteria:**
- Edit `alfred.json` → change `primary_provider`
- Restart container → new provider active
- Automatic fallback if the provider fails

### US-003: Command execution
> As a user, I want Alfred to execute shell commands for me.

**Acceptance criteria:**
- Alfred can execute allowed commands
- Dangerous commands are blocked
- Output is shown in the response

### US-004: Web search
> As a user, I want to ask about current topics and get answers with sources.

**Acceptance criteria:**
- "What happened today?" → Alfred searches and summarizes
- Cites sources in the response
- No API cost (DuckDuckGo)

## 8. Roadmap

### v1.0 (MVP) — Implemented
- [x] WebSocket gateway
- [x] Centralized config loader
- [x] LLM Router (Ollama cloud + fallback chain)
- [x] SOUL.md loader + injector
- [x] Telegram plugin
- [x] Tools: exec, file-ops, web-search, web-fetch
- [x] SQLite schema + repositories
- [x] CLI testing client
- [x] Dockerfile + docker-compose
- [x] Security: rate limiter, auth, ACL

### v1.5 — September 2026
- [ ] Skills loader (SKILL.md parser)
- [ ] Web dashboard (Vue/React)
- [ ] Advanced audit logging
- [ ] OpenAI and Gemini as active providers

### v2.0 — Q4 2026
- [x] Context Compression (Sliding Window + Summary)
- [ ] Discord plugin
- [ ] Slack plugin
- [ ] Redis for distributed sessions
- [ ] LanceDB for embeddings
- [ ] Voice support

### v3.0+ — 2027
- [ ] Advanced RAG memory with vector store
- [ ] Cross-session long-term memory
- [ ] Cloud deployment
- [ ] Multi-user support
- [ ] Advanced workflows
- [ ] Custom LLM providers
- [ ] Mobile apps

### v3.0+ — 2027
- [ ] Cloud deployment
- [ ] Multi-user support
- [ ] Advanced workflows
- [ ] Custom LLM providers
- [ ] Mobile apps

## 9. Success Metrics

| Metric | Target v1.0 | Target v1.5 |
|---|---|---|
| Active channels | 2 (Telegram + CLI) | 2 (Telegram + CLI) |
| LLM providers | 3 configured | 5 active |
| Tests | >10 unit tests | >30 tests |
| Setup time | <5 min | <5 min |
| Docker size | ~180MB | <200MB |
| Uptime | 99% | 99.5% |

## 10. Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| Expired LLM API key | High | Medium | Automatic fallback to next provider |
| Telegram rate limiting | Medium | Low | Message queue + rate limiter |
| SQLite locked under high concurrency | Medium | Low | WAL mode + timeouts |
| Paid API cost (Anthropic/OpenAI) | Medium | High | Ollama cloud as primary (free) |
