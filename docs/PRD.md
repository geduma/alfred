# PRD — Product Requirements Document

## Alfred Pennyworth — Agente IA Personal Multicanal

**Versión:** 2.1.0  
**Fecha:** Julio 2026  
**Estado:** Implementado

---

## 1. Resumen Ejecutivo

Alfred es un asistente IA personal que funciona como gateway multicanal descentralizado. Permite al usuario interactuar con modelos de lenguaje (LLM) a través de Telegram y CLI, con personalidad persistente, acceso a internet y ejecución de herramientas, todo en un solo contenedor Docker.

## 2. Problema

El usuario necesita un asistente IA que:
- Sea multicanal (Telegram, CLI)
- Pueda cambiar de LLM sin modificar código
- Tenga personalidad consistente
- Acceda a internet para información actualizada
- Ejecute comandos y manipule archivos localmente
- Sea 100% autogestionable y open-source
- Se ejecute en un solo contenedor Docker

## 3. Visión del Producto

Un agente IA personal con personalidad (SOUL.md) que opera como mayordomo digital, accesible desde cualquier canal de mensajería, con capacidad de ejecutar tareas, buscar información y mantener contexto, todo configurado desde un único archivo JSON.

## 4. Stack Técnico

| Componente | Especificación |
|---|---|
| Runtime | Node.js 22 LTS |
| Lenguaje | TypeScript 5.4+ |
| Base de datos | SQLite3 embebido |
| WebSocket | ws@8.17 |
| Logging | pino@8.18 |
| Validación | zod@3.22 |
| Testing | Jest + ts-jest |
| Docker | node:22-alpine, multi-stage build |
| Tamaño imagen | ~0.5-1.0 GB (base node:22-alpine ~180MB; WhatsApp/Chromium eliminados)

## 5. Características Funcionales (Features)

### F5.1 Configuración Centralizada
- **ID:** F-CONFIG-001
- **Descripción:** Todo se configura desde un único archivo `alfred.json`
- **Validación:** Schema con Zod en startup
- **Cobertura:** LLM providers, canales, tools, seguridad, base de datos, logging

### F5.2 LLM Agnóstico
- **ID:** F-LLM-001
- **Descripción:** Soporta múltiples providers sin cambiar código
- **Providers:** openai-compatible (Ollama, RunPod, LocalAI), Anthropic, OpenAI, Gemini
- **Fallback:** Cadena automática si el provider principal falla
- **Config:** `llm.primary_provider` + `llm.fallback_providers`

### F5.3 Personalidad Persistente (SOUL.md)
- **ID:** F-SOUL-001
- **Descripción:** Archivo Markdown define tono, valores, límites y comportamiento
- **Inyección:** Se carga en cada interacción como parte del system prompt
- **Idioma:** Siempre español latinoamericano
- **Tratamiento:** "Señor [user_name]" (dinámico desde preferences.md)

### F5.4 Gateway WebSocket
- **ID:** F-GW-001
- **Descripción:** Hub central WebSocket (puerto 18789)
- **Protocolo:** JSON-RPC-like (req/res/event)
- **Auth:** Token de gateway
- **Funciones:** connect, agent, skill_list

### F5.5 Canales Multicanal
- **ID:** F-CH-001
- **Descripción:** Múltiples canales de comunicación
- **v1.0:** Telegram (grammy), CLI (readline)
- **v2.0:** Discord, Slack
- **ACL:** Whitelist de usuarios por canal

### F5.6 Tools
- **ID:** F-TOOL-001
- **Descripción:** Conjunto de herramientas ejecutables por el LLM

| Tool | Propósito | Seguridad |
|---|---|---|
| exec | Comandos shell | Allowlist/denylist, timeout, sanitize de env |
| file_ops | CRUD archivos | Confinado a /workspace/files, max 100MB |
| web | Búsqueda web + fetch (unificado) | DuckDuckGo, timeout, limpieza de HTML |
| job | Recordatorios one-time/recurrentes | Persistidos en workspace/memory/jobs/ |
| system | Health/status/reload | Delegado al gateway |
| health | Hallazgos del health monitor | Solo lectura + check bajo demanda |
| memory | Vector search + snapshots (condicional) | Habilitado solo con sistema de memoria activo |

### F5.7 Persistencia SQLite
- **ID:** F-DB-001
- **Descripción:** Base de datos embebida SQLite
- **Tablas:** sessions, messages, command_log, user_context, skills_cache
- **Features:** WAL mode, foreign keys, auto-migration

### F5.8 Context Compression
- **ID:** F-MEM-001
- **Descripción:** Gestión inteligente del contexto para evitar crecimiento ilimitado
- **Estrategia:** Sliding window + LLM summarization
- **Compresión:** Mensajes antiguos se comprimen en resumen estructurado con secciones: DECISIONS, PREFERENCES, PENDING, CONTEXT, KEY_FACTS
- **Threshold:** Configurable via `memory.max_context_tokens` (default: 32000) y `memory.compaction_threshold` (default: 0.8)
- **Adaptativo:** Ante un error 413/request-too-large, Alfred aprende el límite real del provider y lo persiste en `workspace/memory/provider-budgets.json`, compacta y reintenta (hasta 3 ciclos, luego una vez sin tools). Sin valores hardcodeados por modelo; `provider.config.max_context_tokens` es un override manual opcional
- **Output:** `max_tokens` por llamada se deriva del presupuesto efectivo (`max(512, budget × 0.35)`), acotado por el `max_tokens` configurado
- **Verbatim:** Últimos N mensajes se mantienen intactos (`max_verbatim_messages`, default: 20)
- **Persistencia:** Full history en disco, versión compactada se envía al LLM
- **Fallback:** Si el LLM no genera resumen, se usa heurística basada en mensajes recientes

### F5.8 Skills Modulares (v1.5)
- **ID:** F-SKILL-001
- **Descripción:** Habilidades definidas en SKILL.md con frontmatter YAML
- **Carga:** Sin recompilación, desde /workspace/skills/
- **Discovery:** Automático vía skill_loader tool
- **Secretos:** Las credenciales se almacenan en `workspace/config/secrets.env` (auto-creado desde template), nunca en el SKILL.md
- **Protocolo:** Documentado en `system/alfred-rules.md` → "Secrets Management Protocol"

### F5.9 Secrets Management (v2.0)
- **ID:** F-SECRETS-001
- **Descripción:** Gestión de credenciales para skills (API keys, tokens, passwords)
- **Almacenamiento:** `workspace/config/secrets.env` en formato KEY=VALUE
- **Permisos:** Solo lectura para Alfred (vía file_ops → `/workspace/config` = `r`)
- **Template:** `system/secrets.env.example` se auto-crea en primer startup
- **Acceso:** Alfred lee el archivo cuando ejecuta una skill y pasa secretos al tool `exec` vía parámetro `env` (sanitizado de logs)
- **Uso:** El usuario gestiona el archivo manualmente; Alfred notifica qué variables necesita

### F5.10 Seguridad
- **ID:** F-SEC-001
- **Descripción:** Seguridad en capas
- **Capas:** Gateway auth, tool policy, channel ACL, file confinement, audit logging, rate limiting, secrets isolation

## 6. Requisitos No Funcionales

| ID | Requisito | Métrica |
|---|---|---|
| NFR-001 | Agnóstico a LLM | Sin código específico por provider |
| NFR-002 | Single container | Docker con SQLite embebido |
| NFR-003 | 100% open-source | Stack sin costo de licencias |
| NFR-004 | Tiempo de respuesta | <30s por request (incluyendo LLM) |
| NFR-005 | Escalable horizontal | Sessions distribuidas vía Redis (v2.0) |
| NFR-006 | Type-safe | TypeScript strict + Zod runtime |
| NFR-007 | Resiliente | Fallback automático de providers |
| NFR-008 | Auditable | Todos los comandos loggeados en SQLite |

## 7. User Stories

### US-001: Conversación vía Telegram
> Como usuario, quiero chatear con Alfred via Telegram para obtener respuestas rápidas.

**Criterios de aceptación:**
- Mensaje en Telegram → Alfred responde en <30s
- Personalidad SOUL.md se mantiene
- Alfred puede buscar en internet si es necesario

### US-002: Cambio de LLM
> Como usuario, quiero cambiar el modelo LLM editando un archivo, no código.

**Criterios de aceptación:**
- Editar `alfred.json` → cambiar `primary_provider`
- Reiniciar contenedor → nuevo provider activo
- Fallback automático si el provider falla

### US-003: Ejecución de comandos
> Como usuario, quiero que Alfred ejecute comandos shell por mí.

**Criterios de aceptación:**
- Alfred puede ejecutar comandos permitidos
- Comandos peligrosos son bloqueados
- Output se muestra en la respuesta

### US-004: Búsqueda web
> Como usuario, quiero preguntar sobre temas actuales y obtener respuestas con fuentes.

**Criterios de aceptación:**
- "¿Qué pasó hoy?" → Alfred busca y resume
- Cita fuentes en la respuesta
- Sin costo de API (DuckDuckGo)

## 8. Roadmap

### v1.0 (MVP) — Implementado
- [x] Gateway WebSocket
- [x] Config loader centralizado
- [x] LLM Router (Ollama cloud + fallback chain)
- [x] SOUL.md loader + inyector
- [x] Telegram plugin
- [x] Tools: exec, file-ops, web-search, web-fetch
- [x] SQLite schema + repositorios
- [x] CLI client de testing
- [x] Dockerfile + docker-compose
- [x] Seguridad: rate limiter, auth, ACL

### v1.5 — Septiembre 2026
- [ ] Skills loader (SKILL.md parser)
- [ ] Web dashboard (Vue/React)
- [ ] Audit logging avanzado
- [ ] OpenAI y Gemini como providers activos

### v2.0 — Q4 2026
- [x] Context Compression (Sliding Window + Summary)
- [ ] Discord plugin
- [ ] Slack plugin
- [ ] Redis para sesiones distribuidas
- [ ] LanceDB para embeddings
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

## 9. Métricas de Éxito

| Métrica | Target v1.0 | Target v1.5 |
|---|---|---|
| Canales activos | 2 (Telegram + CLI) | 2 (Telegram + CLI) |
| LLM providers | 3 configurados | 5 activos |
| Tests | >10 unit tests | >30 tests |
| Tiempo setup | <5 min | <5 min |
| Tamaño Docker | ~180MB | <200MB |
| Uptime | 99% | 99.5% |

## 10. Riesgos y Mitigaciones

| Riesgo | Impacto | Probabilidad | Mitigación |
|---|---|---|---|
| API key de LLM expirada | Alto | Media | Fallback automático a siguiente provider |
| Rate limiting de Telegram | Medio | Baja | Queue de mensajes + rate limiter |
| SQLite locked en alta concurrencia | Medio | Baja | WAL mode + timeouts |
| Costo de API de pago (Anthropic/OpenAI) | Medio | Alta | Ollama cloud como primary (gratuito) |
