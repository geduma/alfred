# AGENTS.md — Instrucciones para Agentes IA

## Proyecto: Alfred Pennyworth — Agente IA Personal Multicanal

---

## Stack

- **Runtime:** Node.js 22 LTS
- **Lenguaje:** TypeScript 5.4+ (strict mode)
- **Base de datos:** SQLite3 embebido
- **WebSocket:** ws@8.17
- **Logging:** pino@8.18
- **Validación:** zod@3.22
- **Test:** Jest + ts-jest
- **Docker:** node:22-alpine (~180MB)

## Comandos

```bash
npm run build        # Compilar TypeScript
npm run dev          # Desarrollo con hot-reload (tsx watch)
npm start            # Producción
npm test             # Jest
npm run lint         # ESLint
npm run docker:build # docker compose build
npm run docker:up    # docker compose up -d
```

## Estructura

```
src/
├── index.ts              ← Entry point (wiring de todos los módulos)
├── gateway.ts            ← WebSocket server (puerto 18789)
├── config/loader.ts      ← Config loader con validación Zod
├── agent/
│   ├── llm-router.ts     ← Router con fallback chain automático
│   ├── prompt-builder.ts ← System prompt + SOUL.md injection
│   ├── soul-loader.ts    ← Carga de personalidad
│   └── providers/        ← Abstraction layer de LLM
│       ├── base.ts       ← Provider abstracto
│       ├── factory.ts    ← Factory pattern
│       ├── openai-compatible.ts
│       ├── anthropic.ts
│       └── gemini.ts
├── tools/                ← Tool suite
│   ├── exec.ts           ← Shell con allowlist/denylist
│   ├── file-ops.ts       ← CRUD archivos confinado a /workspace/files
│   ├── web-search.ts     ← DuckDuckGo scraping
│   └── web-fetch.ts      ← HTML fetch + cheerio parsing
├── channels/             ← Canales de comunicación
│   ├── channel-manager.ts
│   ├── telegram.ts       ← Grammy bot
│   ├── whatsapp.ts       ← whatsapp-web.js
│   └── cli.ts            ← Readline interactivo
├── db/                   ← Persistencia SQLite
│   ├── schema.sql        ← 5 tablas
│   ├── index.ts          ← Init + migrations
│   └── repositories/     ← Sessions, Messages, Commands
├── security/
│   ├── rate-limiter.ts   ← Rate limiting por usuario/canal
│   └── auth.ts           ← Gateway token + ACL
├── types/                ← TypeScript interfaces
└── utils/logger.ts       ← Pino logger estructurado
```

## Convenciones de Código

- TypeScript strict: `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- Clases exportadas, interfaces en `src/types/`
- Sin comentarios en código
- Errores se manejan con try/catch y se loggean con `getLogger()`
- Nombres de archivos: kebab-case (ej: `web-search.ts`, `file-ops.ts`)
- Las tools implementan la interfaz `ToolHandler` de `src/types/tool.ts`
- Los canales implementan la interfaz `Channel` de `src/types/channel.ts`

## Configuración

Un solo archivo: `workspace/config/alfred.json`

- `llm.primary_provider` → Provider activo
- `llm.fallback_providers` → Cadena de fallback
- `providers` → Lista completa de providers (cada uno con `type`, `enabled`, `model`, `config`)
- `tools` → Configuración individual por tool
- `channels` → Canal + permisos (ACL via `allow_from`)
- `database` → Ruta SQLite + settings
- `security.gateway_auth_token` → Token mínimo 16 caracteres

## Testing

- Tests unitarios en `tests/unit/`
- Usar Jest con `ts-jest`
- Correr: `npm test`

## Docker

```bash
# Build
docker compose -f docker/docker-compose.yml build

# Run
docker compose -f docker/docker-compose.yml up -d

# Logs
docker compose -f docker/docker-compose.yml logs -f alfred
```

Volumen: `~/.alfred-personal:/workspace`

## Notas para Agentes

1. **No modificar** `workspace/config/alfred.json` con valores reales de API keys — es template
2. **No instalar** dependencias adicionales sin evaluar si son necesarias
3. **Preservar** el patrón de Provider Factory al agregar nuevos LLM providers
4. **Preservar** la interfaz `Channel` al agregar nuevos canales
5. Si se agrega un nuevo tool, registrarlo en `src/tools/index.ts`
6. **Compilar siempre** (`npx tsc --noEmit`) antes de finalizar cambios
7. **Ejecutar tests** (`npm test`) para verificar que no se rompe nada
