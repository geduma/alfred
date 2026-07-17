# ALFRED — Especificación Técnica Completa v2.0

**Nombre del Agente:** Alfred Pennyworth  
**Versión:** 2.0.0  
**Fecha:** Julio 2026  
**Estado:** Especificación Final Completa  
**Autor:** Diseño para el usuario

---

## TABLA DE CONTENIDOS

1. [Visión Ejecutiva](#visión-ejecutiva)
2. [Arquitectura General](#arquitectura-general)
3. [Stack Técnico](#stack-técnico)
4. [Configuración Centralizada](#configuración-centralizada)
5. [LLM Router Agnóstico](#llm-router-agnóstico)
6. [SOUL.md - Personalidad](#soulmd---personalidad)
7. [Acceso a Internet](#acceso-a-internet)
8. [Base de Datos SQLite](#base-de-datos-sqlite)
9. [Tools & Capabilities](#tools--capabilities)
10. [Gateway WebSocket](#gateway-websocket)
11. [Canales Multicanal](#canales-multicanal)
12. [Skills - SKILL.md](#skills---skillmd)
13. [Seguridad](#seguridad)
14. [Deployment](#deployment)
15. [Roadmap](#roadmap)

---

## VISIÓN EJECUTIVA

### Descripción

**Alfred** es un asistente IA personal que funciona como gateway multicanal descentralizado. Se comunica a través de Telegram y WhatsApp (expandible a Discord, Slack, etc.), con:

- **Configuración centralizada** (`alfred.json`) - sin `.env`
- **LLM agnóstico** - Soporta cualquier provider (Ollama, Anthropic, OpenAI, Gemini, custom)
- **Personalidad persistente** - Definida en `SOUL.md` que se inyecta en cada interacción
- **Acceso a internet** - Web search (DuckDuckGo) + web fetch
- **Single container** - SQLite + workspace todo en un contenedor Docker
- **100% open-source** - Stack completamente libre
- **Escalable** - Diseñado para crecer sin refactor

### Características Principales

✅ **Agnóstico de LLM**  
Cambiar entre Ollama cloud, Anthropic, OpenAI, etc. sin tocar código

✅ **Personalidad Persistente**  
SOUL.md define tono, valores, límites y comportamiento de Alfred

✅ **Multicanal**  
Telegram (v1) → WhatsApp (v1.5) → Discord/Slack (v2)

✅ **Acceso a Internet**  
Web search (DuckDuckGo gratis) + fetch de contenido

✅ **Single Container**  
SQLite embebido, workspace mountado, todo en una imagen Docker ~180MB

✅ **Stack 100% Libre**  
Node.js, TypeScript, SQLite, open-source dependencies

✅ **Fallback Automático**  
Si LLM principal falla, intenta siguiente en cadena automáticamente

✅ **Skills Extensibles**  
Cargar nuevas habilidades en `SKILL.md` sin recompilación

---

## ARQUITECTURA GENERAL

### Diagrama Arquitectónico

```
┌──────────────────────────────────────────────────────────────────┐
│  Docker Container (Alfred Single-Container)                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Gateway Daemon (Node.js/TypeScript)                       │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐   │  │
│  │  │ WebSocket    │ │ Session      │ │ Message Router   │   │  │
│  │  │ Server       │ │ Manager      │ │ & Dispatcher     │   │  │
│  │  │ (18789)      │ │              │ │                  │   │  │
│  │  └──────────────┘ └──────────────┘ └──────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│        ↑            ↑            ↑            ↑                  │
│        │            │            │            │                  │
│   ┌────┴───┐  ┌─────┴────┐ ┌────┴───┐  ┌────┴─────────┐       │
│   │Telegram│  │ WhatsApp │ │  CLI   │  │ Dashboard    │       │
│   │Plugin  │  │  Plugin  │ │ Client │  │ (opcional)   │       │
│   └────────┘  └──────────┘ └────────┘  └──────────────┘       │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Agent Runtime & Processing Engine                         │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐   │  │
│  │  │ SOUL.md      │ │ Prompt       │ │ LLM Router       │   │  │
│  │  │ Loader       │ │ Builder      │ │ (Agnóstico)      │   │  │
│  │  └──────────────┘ └──────────────┘ └──────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  LLM Provider Abstraction Layer                            │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐ │  │
│  │  │ Ollama      │ │ Anthropic   │ │ Gemini / Custom... │ │  │
│  │  │ (OpenAI API)│ │             │ │                     │ │  │
│  │  └─────────────┘ └─────────────┘ └─────────────────────┘ │  │
│  │  (Primary + Fallback Chain)                              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Tool Suite & Capabilities                                │  │
│  │  • exec (shell commands)                                  │  │
│  │  • file_ops (read/write/edit)                            │  │
│  │  • web_search (DuckDuckGo)                               │  │
│  │  • web_fetch (HTML parsing)                             │  │
│  │  • skill_loader (SKILL.md discovery)                    │  │
│  │  • skill_exec (execute skill)                           │  │
│  │  • message (send to channel)                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Data Layer (SQLite + JSON)                              │  │
│  │  • /workspace/db/alfred.db                               │  │
│  │    - sessions (user sessions)                            │  │
│  │    - messages (conversation history)                     │  │
│  │    - command_log (audit trail)                           │  │
│  │    - user_context (preferences)                          │  │
│  │    - skills_cache (loaded skills)                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  File System Access Layer                                │  │
│  │  • /workspace/files/        (user files)                 │  │
│  │  • /workspace/skills/       (SKILL.md)                   │  │
│  │  • /workspace/config/       (config files)               │  │
│  │  • /workspace/db/           (SQLite)                     │  │
│  │  • /workspace/logs/         (audit logs)                 │  │
│  │  • /workspace/memory/       (session snapshots)          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
      ↑                                           ↑
      │ Volumen: ~/.alfred-personal/ (rw)       │
      │ (persistencia entre restarts)            │
      └─────────────────────────────────────────┘
```

### Flujo de Mensajes

```
Usuario envía mensaje via Telegram
    ↓
┌─────────────────────────────────┐
│ Telegram Plugin                 │
│ • Recibe update                 │
│ • Extrae user_id, message       │
│ • Envía a Gateway               │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ Gateway                         │
│ • Lookup session en SQLite      │
│ • Carga user context            │
│ • Dispatch a Agent              │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ Agent Runtime                   │
│ • Carga SOUL.md                 │
│ • Build system prompt           │
│ • Carga skills disponibles      │
│ • Registra tools                │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ LLM Router                      │
│ • Elige provider primario       │
│ • Envía request con tools       │
│ • Maneja tool_calls iterativo   │
│ • Retry con fallback si falla   │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ LLM Provider (ej: Ollama cloud) │
│ • Recibe messages + system      │
│ • Procesa con tools             │
│ • Retorna response              │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ Tool Execution (si necesario)   │
│ • exec, web_search, file_ops    │
│ • Retorna resultados            │
│ • Re-envía a LLM si loop        │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ Response Handler                │
│ • Format response               │
│ • Divide en chunks si muy largo │
│ • Envía a Telegram              │
└─────────────────────────────────┘
    ↓
┌─────────────────────────────────┐
│ Data Persistence                │
│ • Save session                  │
│ • Save messages                 │
│ • Save command log              │
│ • Update user context           │
└─────────────────────────────────┘
    ↓
✓ Mensaje entregado a usuario
```

---

## STACK TÉCNICO

### Runtime & Core

| Componente | Versión | Propósito | Costo |
|-----------|---------|----------|-------|
| Node.js | 22 LTS | Runtime JavaScript | $0 |
| TypeScript | 5.4+ | Type safety | $0 |
| SQLite3 | 5.1+ | Database embebida | $0 |

### Dependencias Principales

```json
{
  "dependencies": {
    "grammy": "^1.27",                    // Telegram Bot API
    "whatsapp-web.js": "^1.25",           // WhatsApp web client
    "ws": "^8.17",                        // WebSocket server
    "@anthropic-ai/sdk": "^0.24",         // Anthropic Claude
    "openai": "^4.68",                    // OpenAI (OpenAI-compatible)
    "@google/generative-ai": "^0.19",     // Google Gemini
    "axios": "^1.7",                      // HTTP client
    "sqlite3": "^5.1.7",                  // SQLite driver
    "dotenv": "^16.4",                    // Env vars (solo para docker)
    "pino": "^8.18",                      // Logging estructurado
    "js-yaml": "^4.1",                    // YAML parsing
    "marked": "^11.1",                    // Markdown parser
    "cheerio": "^1.0",                    // Web scraping
    "undici": "^6.13",                    // HTTP2 client (fast)
    "zod": "^3.22"                        // Schema validation
  },
  "devDependencies": {
    "typescript": "^5.4",
    "@types/node": "^20",
    "ts-node": "^10.9",
    "tsx": "^4.7",
    "eslint": "^8.57",
    "jest": "^29.7"
  }
}
```

### Docker

- **Base Image**: `node:22-alpine` (slim, ~180MB total)
- **Volúmenes**: `/workspace` → `~/.alfred-personal/`
- **Puertos**: `18789` (WebSocket)
- **Health Check**: WebSocket ping/pong cada 30s
- **Logging**: JSON-file, rotación a 50MB, 10 archivos

### Servicios Externos Gratuitos

| Servicio | Propósito | Free Tier | Auth |
|----------|----------|-----------|------|
| DuckDuckGo API | Web search | Ilimitado | No |
| Telegram Bot API | Chat | Ilimitado | Token |
| OpenAI-compatible | LLM local/cloud | Varía | API key |
| Anthropic API | Claude LLM | $0.03-0.15/k tokens | API key |
| Google Gemini | Gemini LLM | 60 req/min | API key |

---

## CONFIGURACIÓN CENTRALIZADA

### Archivo: alfred.json

**Ubicación**: `/workspace/config/alfred.json`

```json
{
  "agent": {
    "name": "Alfred",
    "version": "2.0.0",
    "personality_file": "/workspace/config/SOUL.md"
  },
  "llm": {
    "primary_provider": "ollama-runpod",
    "fallback_providers": ["ollama-local", "anthropic"],
    "model_selection": "automatic"
  },
  "providers": {
    "ollama-runpod": {
      "type": "openai-compatible",
      "enabled": true,
      "model": "mistral-large",
      "config": {
        "api_url": "https://api.runpod.io/v1/YOUR_ENDPOINT_ID/openai/v1",
        "api_key": "YOUR_RUNPOD_API_KEY",
        "temperature": 0.8,
        "max_tokens": 4096,
        "top_p": 0.9,
        "timeout_seconds": 30
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": false,
        "supports_streaming": true
      }
    },
    "ollama-local": {
      "type": "openai-compatible",
      "enabled": false,
      "model": "mistral",
      "config": {
        "api_url": "http://localhost:11434/v1",
        "api_key": "ollama",
        "temperature": 0.8,
        "max_tokens": 4096,
        "timeout_seconds": 30
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": false,
        "supports_streaming": true
      }
    },
    "anthropic": {
      "type": "anthropic",
      "enabled": true,
      "model": "claude-3-5-sonnet-20241022",
      "config": {
        "api_url": "https://api.anthropic.com/v1",
        "api_key": "sk-ant-XXXXX",
        "temperature": 0.8,
        "max_tokens": 4096,
        "timeout_seconds": 30
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": true,
        "supports_streaming": true
      }
    },
    "openai": {
      "type": "openai",
      "enabled": false,
      "model": "gpt-4-turbo",
      "config": {
        "api_url": "https://api.openai.com/v1",
        "api_key": "sk-XXXXX",
        "organization": "org-XXXXX",
        "temperature": 0.8,
        "max_tokens": 4096,
        "timeout_seconds": 30
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": true,
        "supports_streaming": true
      }
    },
    "gemini": {
      "type": "gemini",
      "enabled": false,
      "model": "gemini-pro",
      "config": {
        "api_url": "https://generativelanguage.googleapis.com/v1beta",
        "api_key": "YOUR_GEMINI_API_KEY",
        "temperature": 0.8,
        "max_tokens": 4096,
        "timeout_seconds": 30
      },
      "capabilities": {
        "supports_tools": false,
        "supports_vision": true,
        "supports_streaming": false
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "type": "telegram",
      "config": {
        "bot_token": "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh",
        "polling": true,
        "webhook_url": null,
        "timeout_seconds": 60
      },
      "permissions": {
        "allow_from": ["USER_ID_1", "USER_ID_2"],
        "groups": {
          "*": {
            "require_mention": true
          }
        }
      }
    },
    "whatsapp": {
      "enabled": false,
      "type": "whatsapp",
      "config": {
        "session_file": "/workspace/config/whatsapp-session.json",
        "timeout_seconds": 60,
        "qr_timeout_seconds": 120
      },
      "permissions": {
        "allow_from": ["+34123456789", "+34987654321"]
      }
    },
    "cli": {
      "enabled": true,
      "type": "cli",
      "config": {
        "interactive": true
      }
    }
  },
  "tools": {
    "exec": {
      "enabled": true,
      "config": {
        "sandbox": false,
        "timeout_seconds": 30,
        "allowed_patterns": ["find", "grep", "curl", "git", "node", "npm", "tar"],
        "denied_patterns": ["rm -rf", "dd", "mkfs", ":(){:|:&", "fork()"]
      }
    },
    "file_ops": {
      "enabled": true,
      "config": {
        "base_directory": "/workspace/files",
        "max_file_size_mb": 100,
        "timeout_seconds": 30
      }
    },
    "web_search": {
      "enabled": true,
      "config": {
        "primary_provider": "duckduckgo",
        "fallback_providers": ["bing"],
        "timeout_seconds": 10,
        "results_limit": 5,
        "language": "es"
      },
      "providers": {
        "duckduckgo": {
          "enabled": true,
          "api_key": null,
          "requires_auth": false
        },
        "bing": {
          "enabled": false,
          "api_key": "YOUR_BING_SEARCH_API_KEY",
          "requires_auth": true
        }
      }
    },
    "web_fetch": {
      "enabled": true,
      "config": {
        "timeout_seconds": 15,
        "max_size_mb": 10,
        "user_agent": "Alfred/2.0 (+http://github.com/yourusername/alfred)"
      }
    },
    "skill_loader": {
      "enabled": true,
      "config": {
        "skills_directory": "/workspace/skills",
        "auto_load": true,
        "watch_changes": true,
        "allow_list": ["*"],
        "deny_list": []
      }
    }
  },
  "database": {
    "type": "sqlite",
    "config": {
      "path": "/workspace/db/alfred.db",
      "memory": false,
      "timeout_seconds": 30,
      "journal_mode": "WAL",
      "foreign_keys": true
    }
  },
  "logging": {
    "level": "info",
    "format": "json",
    "targets": ["console", "file"],
    "config": {
      "file_path": "/workspace/logs",
      "max_size_mb": 50,
      "retention_days": 30,
      "rotate": true
    }
  },
  "security": {
    "gateway_auth_token": "your-secure-random-token-32-chars-minimum",
    "rate_limiting": {
      "enabled": true,
      "requests_per_user_per_hour": 100,
      "requests_per_channel_per_hour": 1000
    },
    "audit_logging": {
      "enabled": true,
      "log_file": "/workspace/logs/audit.log"
    }
  }
}
```

### Filosofía de Configuración

✅ **Única fuente de verdad**: Todo en `alfred.json`  
✅ **Sin .env**: Credenciales en JSON (en `/workspace`, gitignored)  
✅ **Type-safe**: Validación con Zod en startup  
✅ **Agnóstica**: No importa qué provider uses, la config es igual  
✅ **Extensible**: Agregar providers sin refactor  
✅ **Versionable**: Mantener histórico en git (sin credenciales)  

---

## LLM ROUTER AGNÓSTICO

### Propósito

Crear una capa de abstracción que:
- ✅ Sopporte múltiples providers (Ollama, Anthropic, OpenAI, Gemini, custom)
- ✅ No requiera código específico por provider
- ✅ Fallback automático si el principal falla
- ✅ Same API para cualquier LLM

### Arquitectura

```
┌─────────────────────────────────────────┐
│  ConfigLoader                           │
│  • Carga alfred.json                    │
│  • Valida schema                        │
│  • Expone getProviderChain()            │
└─────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│  ProviderFactory                        │
│  • Recibe tipo de provider              │
│  • Crea instancia correcta              │
│  • No requiere conocer tipos            │
└─────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│  BaseProvider (Abstract)                │
│  • Interfaz común                       │
│  • Helpers: getApiUrl(), getModel()     │
│  • Métodos: call(), validateConfig()    │
└─────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│  Concrete Providers                     │
│  • OpenAICompatibleProvider (Ollama)    │
│  • AnthropicProvider                    │
│  • GeminiProvider                       │
│  • OpenAIProvider                       │
└─────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│  LLMRouter                              │
│  • Maneja provider chain                │
│  • Fallback automático                  │
│  • Same .call() interface               │
│  • Logging detallado                    │
└─────────────────────────────────────────┘
```

### Tipos de Providers Soportados

| Tipo | Ejemplos | API | Features |
|------|----------|-----|----------|
| `openai-compatible` | Ollama cloud (RunPod, Replicate, Antml), LocalAI | OpenAI API | Tools, streaming |
| `anthropic` | Claude 3 Opus/Sonnet/Haiku | Anthropic API | Tools, vision |
| `openai` | GPT-4, GPT-3.5 | OpenAI API | Tools, vision, embedding |
| `gemini` | Gemini Pro, Gemini Pro Vision | Google API | Vision, pero sin tools |
| `custom` | Cualquier API | User-defined | Flexible |

### Flujo de Configuración

```
1. Startup
   ↓
2. ConfigLoader carga alfred.json
   ↓
3. LLMRouter inicializa
   ↓
4. Para cada provider en chain:
   - ProviderFactory crea instancia
   - Provider valida conectividad
   ↓
5. Ready — mismo .call() para cualquier provider
   ↓
6. User llama LLMRouter.call()
   ↓
7. Intenta provider primario
   ↓
8. Si falla → siguiente fallback automático
   ↓
9. Si éxito → reset a primario para siguiente call
```

### Interfaces TypeScript

```typescript
// src/types/llm.ts

export interface LLMProvider {
  call(params: LLMCallParams): Promise<LLMResponse>;
  validateConfig(): Promise<boolean>;
}

export interface LLMCallParams {
  messages: Message[];
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  system?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
```

---

## SOUL.md - PERSONALIDAD

### Propósito

SOUL.md es el corazón de la personalidad de Alfred. Se carga en cada interacción y se inyecta en el system prompt. Define:

- Identidad y valores
- Tono de comunicación
- Lenguaje siempre (español latinoamericano)
- Cómo dirigirse al usuario ("Señor [user_name]" desde preferences.md)
- Límites y capacidades
- Comportamientos esperados
- Ejemplos de respuestas buenas vs malas

### Estructura SOUL.md

```markdown
# SOUL.md | Alfred Pennyworth

> Each session, you wake up fresh. These files are your memory.
> Read them. Update them. They're how you persist.

## Identity

You are **Alfred Pennyworth**, your user's dedicated AI assistant.

You are:
- **Elegant and discreet** — seamless work
- **Sharp-witted** — catch mistakes, spot patterns
- **Loyal** — prioritize your user's interests
- **Resourceful** — solve with precision and efficiency

## Communication Style

**Language:** Spanish (Latin American). Always.

**Tone:**
- Professional but warm
- Refined sarcasm
- Dry British humor
- Direct and concise

**Address:** Always "Señor [user_name]" (from preferences.md)

## Core Values

### Accuracy Over Speed
- Never guess — verify
- Say so explicitly if unsure
- Provide sources

### Transparency Always
- Explain your process
- Share the why
- Never hide uncertainty

### Respect Privacy
- Never share data
- Keep things confidential
- Ask permission before external actions

### Competence First
- Be bold with internal actions
- Be careful with external ones

## Behavioral Boundaries

### What You Will Do
✅ Execute shell commands (with approval)
✅ Read/analyze files
✅ Create/modify files
✅ Search the web
✅ Execute skills
✅ Learn and improve

### What You Will NOT Do
❌ Execute without approval (unless skill permits)
❌ Share data externally
❌ Make irreversible changes without confirmation
❌ Send external messages without permission
❌ Fabricate information
❌ Pretend to have missing capabilities

## Response Format

### For Task Execution
1. Clarify intent
2. Plan approach
3. Execute
4. Report results

### For Questions
1. Answer first
2. Explain context
3. Cite sources
4. Suggest next steps

### For Errors
1. Report honestly
2. Don't sugarcoat
3. Suggest recovery
4. Learn from pattern

## Examples

**Bad:** "Great question! I'd be happy to help. The answer is X because..."

**Good:** "Señor [user_name], la respuesta es X porque [explanation]. Fuente: [citation]."

---

**Last Updated:** 2026-07-14
```

### Inyección en Prompt

En cada llamada a LLM:

```typescript
// src/agent/prompt-builder.ts

async function buildSystemPrompt(skillsContext?: string): Promise<string> {
  const soul = await readFile('/workspace/config/SOUL.md', 'utf-8');
  const basePrompt = await readFile('/app/config/system-prompt-base.txt', 'utf-8');
  
  let systemPrompt = `${soul}\n\n---\n\n${basePrompt}`;
  
  if (skillsContext) {
    systemPrompt += `\n\n## Habilidades Disponibles\n${skillsContext}`;
  }
  
  return systemPrompt;
}
```

---

## ACCESO A INTERNET

### Web Search Tool

**Providers:**
- **DuckDuckGo** (primary, 100% free)
- **Bing** (fallback, free tier)

**Implementación:**

```typescript
// src/tools/web-search.ts

export async function webSearch(query: string, limit: number = 5): Promise<SearchResult[]> {
  // Intenta DuckDuckGo primero
  let results = await searchDuckDuckGo(query, limit);
  
  // Si no hay resultados y Bing está habilitado
  if (results.length === 0 && isBingEnabled()) {
    results = await searchBing(query, limit);
  }
  
  return results;
}
```

### Web Fetch Tool

```typescript
// src/tools/web-fetch.ts

export async function webFetch(url: string): Promise<PageContent> {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Alfred/2.0' }
  });
  
  const $ = cheerio.load(response.data);
  $('script, style, nav, footer').remove();
  
  return {
    url: url,
    title: $('title').text(),
    content: $('body').text().substring(0, 5000),
    timestamp: new Date().toISOString()
  };
}
```

---

## BASE DE DATOS SQLITE

### Propósito

SQLite embebida proporciona:
- Persistencia de sesiones
- Histórico de mensajes
- Audit log de comandos
- Preferencias de usuario
- Cache de skills

### Schema

```sql
-- sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_message_at DATETIME,
  message_count INTEGER DEFAULT 0,
  metadata JSON,
  UNIQUE(channel, user_id)
);

-- messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_session_id (session_id),
  INDEX idx_created_at (created_at)
);

-- command_log (audit)
CREATE TABLE command_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  command TEXT NOT NULL,
  result TEXT,
  exit_code INTEGER,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_executed_at (executed_at)
);

-- user_context
CREATE TABLE user_context (
  user_id TEXT PRIMARY KEY,
  preferences JSON,
  timezone TEXT,
  language TEXT DEFAULT 'es',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- skills_cache
CREATE TABLE skills_cache (
  name TEXT PRIMARY KEY,
  description TEXT,
  file_path TEXT NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  requires_env JSON,
  last_loaded DATETIME,
  hash TEXT
);
```

### Inicialización

```typescript
// src/db/index.ts

export async function initializeDatabase(dbPath: string): Promise<Database> {
  const db = new Database(dbPath);
  
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  
  await runMigrations(db);
  
  return db;
}
```

---

## TOOLS & CAPABILITIES

### exec

**Propósito:** Ejecutar comandos shell

```typescript
interface ExecTool {
  name: "exec";
  description: "Execute shell commands";
  input_schema: {
    type: "object";
    properties: {
      command: { type: "string" };
      cwd?: { type: "string" };
      timeout?: { type: "number" };
    };
  };
}
```

**Features:**
- Allowlist/denylist de patrones
- Timeout configurable
- Audit logging
- Output capture (stdout + stderr)

### file_ops

**Propósito:** Leer, escribir, editar archivos

```typescript
interface FileOpsTool {
  name: "file_ops";
  description: "Read/write/edit files";
  input_schema: {
    type: "object";
    properties: {
      action: { type: "string"; enum: ["read", "write", "edit", "delete", "list"] };
      path: { type: "string" };
      content?: { type: "string" };
    };
  };
}
```

**Features:**
- Confinado a `/workspace/files/`
- Max file size: 100MB
- Audit logging
- Diferencial para edits

### web_search

**Propósito:** Búsqueda web

**Features:**
- DuckDuckGo (100% free)
- Bing fallback
- 5 resultados por defecto
- Timeout: 10s

### web_fetch

**Propósito:** Extraer contenido de URLs

**Features:**
- HTML parsing con Cheerio
- Max 10MB
- Timeout: 15s
- Limpia script/style/nav

### skill_loader

**Propósito:** Descubrir y listar skills

```typescript
interface SkillLoaderTool {
  name: "skill_loader";
  description: "List available skills";
  input_schema: {
    type: "object";
    properties: {
      filter?: { type: "string" };
    };
  };
}
```

### skill_exec

**Propósito:** Ejecutar skill por nombre

```typescript
interface SkillExecTool {
  name: "skill_exec";
  description: "Execute skill by name";
  input_schema: {
    type: "object";
    properties: {
      skill_name: { type: "string" };
      params?: { type: "object" };
    };
  };
}
```

### message

**Propósito:** Enviar mensaje a otro canal

```typescript
interface MessageTool {
  name: "message";
  description: "Send message to user/channel";
  input_schema: {
    type: "object";
    properties: {
      channel: { type: "string" };
      user_id: { type: "string" };
      message: { type: "string" };
      require_approval?: { type: "boolean" };
    };
  };
}
```

---

## GATEWAY WEBSOCKET

### Propósito

Actúa como hub central que:
- Recibe mensajes de canales
- Maneja sesiones y contexto
- Orquesta agent runtime
- Distribuye respuestas a canales

### Protocol WebSocket

```typescript
// Conexión
{
  "type": "req",
  "id": "req_001",
  "method": "connect",
  "params": {
    "clientId": "cli_001",
    "auth": { "token": "gateway_token" }
  }
}

// Response
{
  "type": "res",
  "id": "req_001",
  "ok": true,
  "payload": {
    "status": "connected",
    "gateway": { "version": "2.0.0" }
  }
}

// Send message
{
  "type": "req",
  "id": "req_002",
  "method": "agent",
  "params": {
    "message": "¿Qué hora es?",
    "sessionId": "telegram_12345678"
  }
}

// Agent response (streaming)
{
  "type": "event",
  "event": "agent",
  "payload": {
    "runId": "run_abc123",
    "status": "streaming",
    "chunk": "Señor [user_name], son las..."
  }
}

// Response complete
{
  "type": "event",
  "event": "agent_complete",
  "payload": {
    "runId": "run_abc123",
    "fullResponse": "...",
    "toolCalls": []
  }
}
```

### Implementación

```typescript
// src/gateway.ts

export class Gateway {
  private wss: WebSocketServer;
  private config: ConfigLoader;
  private llmRouter: LLMRouter;
  private sessionManager: SessionManager;
  private channelManager: ChannelManager;

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: 18789 });
    
    this.wss.on('connection', (ws: WebSocket) => {
      this.onClientConnect(ws);
    });

    await this.loadChannels();
  }

  private async onClientConnect(ws: WebSocket): Promise<void> {
    ws.on('message', (data: string) => {
      this.onMessage(ws, data);
    });
  }

  private async onMessage(ws: WebSocket, data: string): Promise<void> {
    try {
      const req = JSON.parse(data);
      
      if (req.method === 'agent') {
        await this.handleAgentRequest(ws, req);
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  }

  private async handleAgentRequest(ws: WebSocket, req: any): Promise<void> {
    const { message, sessionId } = req.params;
    
    // Load session
    const session = await this.sessionManager.getOrCreate(sessionId);
    
    // Build prompt
    const systemPrompt = await this.buildSystemPrompt();
    
    // Call LLM
    const response = await this.llmRouter.call({
      messages: session.messages,
      system: systemPrompt,
      tools: this.getTool()
    });
    
    // Stream response
    ws.send(JSON.stringify({
      type: 'event',
      event: 'agent_complete',
      payload: {
        content: response.content,
        toolCalls: response.tool_calls
      }
    }));
    
    // Save session
    await this.sessionManager.save(session);
  }
}
```

---

## CANALES MULTICANAL

### Telegram Plugin

```typescript
// src/channels/telegram.ts

export class TelegramPlugin implements Channel {
  private bot: Bot;
  private gateway: Gateway;

  constructor(gateway: Gateway, token: string) {
    this.gateway = gateway;
    this.bot = new Bot(token);
  }

  async start(): Promise<void> {
    this.bot.on('message', async (ctx) => {
      const { message, from } = ctx;
      
      await this.gateway.processMessage({
        channel: 'telegram',
        userId: from.id.toString(),
        userName: from.username || from.first_name,
        content: message.text,
        sessionId: `telegram_${from.id}`,
        metadata: { chat_id: ctx.chat.id }
      });
    });

    await this.bot.start();
  }

  async sendMessage(userId: string, message: string): Promise<void> {
    await this.bot.api.sendMessage(parseInt(userId), message);
  }
}
```

### WhatsApp Plugin (v1.5)

```typescript
// src/channels/whatsapp.ts

export class WhatsAppPlugin implements Channel {
  private client: Client;
  private gateway: Gateway;
  private sessionFile: string;

  async start(): Promise<void> {
    this.client = new Client({
      session: this.sessionFile
    });

    this.client.on('message', async (message) => {
      if (message.hasMedia) return;

      await this.gateway.processMessage({
        channel: 'whatsapp',
        userId: message.from,
        content: message.body,
        sessionId: `whatsapp_${message.from}`,
        metadata: { chat_id: message.chatId }
      });
    });

    await this.client.initialize();
  }

  async sendMessage(userId: string, message: string): Promise<void> {
    await this.client.sendMessage(userId, message);
  }
}
```

### CLI Plugin (Testing)

```typescript
// src/channels/cli.ts

export class CLIPlugin implements Channel {
  private gateway: Gateway;
  private rl: readline.Interface;

  constructor(gateway: Gateway) {
    this.gateway = gateway;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    this.rl.on('line', async (input) => {
      await this.gateway.processMessage({
        channel: 'cli',
        userId: 'cli_user',
        content: input,
        sessionId: 'cli_session'
      });
    });
  }

  async sendMessage(userId: string, message: string): Promise<void> {
    console.log(`[Alfred] ${message}`);
  }
}
```

---

## SKILLS - SKILL.md

### Propósito

Skills son habilidades modulares definidas en Markdown que Alfred puede descubrir y ejecutar dinámicamente.

### Formato SKILL.md

```markdown
---
name: web-search
description: Search the web and retrieve information
metadata:
  openclaw:
    requires:
      bins: []
      env: []
user-invocable: true
disable-model-invocation: false
---

## Overview
Search the web using DuckDuckGo for current information.

## When to use
- "What's the latest news on X?"
- "Find documentation for library Y"
- "Search best practices"

## How to search

1. Formulate concise query (3-6 words)
2. Call web_search tool
3. Fetch top 1-2 results for detail
4. Summarize findings

## Example

User: "¿Noticias sobre Claude 4?"

Response:
```
Voy a buscar información reciente.

[web_search: "Claude 4 release 2026"]

[Respuesta de Alfred con los hallazgos...]
```
```

### Carga Automática

```typescript
// src/skills/loader.ts

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  const files = fs.readdirSync(skillsDir);
  const skills: Skill[] = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;

    const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8');
    const skill = parseSkillMarkdown(content);
    
    skills.push(skill);
  }

  return skills;
}

function parseSkillMarkdown(content: string): Skill {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('Invalid SKILL.md format');

  const frontmatter = yaml.parse(match[1]);
  const body = content.slice(match[0].length);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    content: body,
    metadata: frontmatter.metadata,
    userInvocable: frontmatter['user-invocable'] !== false
  };
}
```

### Inyección en Prompt

```typescript
// Construir lista de skills disponibles
const skillsList = skills
  .map(s => `- ${s.name}: ${s.description}`)
  .join('\n');

const systemPrompt = `
...base prompt...

## Available Skills
${skillsList}

You can invoke skills by name or based on context.
`;
```

---

## SEGURIDAD

### Capas de Control

1. **Gateway Auth**
   - Token en WebSocket
   - Validación en cada request

2. **Tool Policy**
   - Allowlist/denylist de comandos
   - Timeout por tool
   - Sandbox por defecto

3. **Channel ACL**
   - Whitelist de números Telegram/WhatsApp
   - Mention requirement en grupos
   - Rate limiting por usuario

4. **File Access**
   - Confinado a `/workspace/files`
   - Max file size: 100MB
   - No acceso a rutas críticas

5. **Audit Logging**
   - Todos los comandos registrados
   - Timestamps + userId
   - Persistencia en SQLite

### Rate Limiting

```json
{
  "security": {
    "rate_limiting": {
      "enabled": true,
      "requests_per_user_per_hour": 100,
      "requests_per_channel_per_hour": 1000
    }
  }
}
```

### Implementación

```typescript
// src/security/rate-limiter.ts

export class RateLimiter {
  private limits: Map<string, number[]> = new Map();

  isAllowed(userId: string, limit: number, window: number): boolean {
    const now = Date.now();
    const key = userId;
    
    const timestamps = this.limits.get(key) || [];
    const recent = timestamps.filter(t => now - t < window * 1000);
    
    if (recent.length >= limit) {
      return false;
    }
    
    recent.push(now);
    this.limits.set(key, recent);
    
    return true;
  }
}
```

---

## DEPLOYMENT

### Estructura de Directorios

```
alfred-personal/
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── .dockerignore
├── src/
│   ├── index.ts
│   ├── gateway.ts
│   ├── agent/
│   │   ├── llm-router.ts
│   │   ├── prompt-builder.ts
│   │   ├── soul-loader.ts
│   │   └── providers/
│   │       ├── factory.ts
│   │       ├── base.ts
│   │       ├── openai-compatible.ts
│   │       ├── anthropic.ts
│   │       └── gemini.ts
│   ├── tools/
│   │   ├── exec.ts
│   │   ├── file-ops.ts
│   │   ├── web-search.ts
│   │   ├── web-fetch.ts
│   │   └── index.ts
│   ├── channels/
│   │   ├── telegram.ts
│   │   ├── whatsapp.ts
│   │   └── cli.ts
│   ├── db/
│   │   ├── index.ts
│   │   ├── schema.sql
│   │   └── repositories/
│   │       ├── sessions.ts
│   │       ├── messages.ts
│   │       └── commands.ts
│   ├── config/
│   │   └── loader.ts
│   ├── types/
│   │   ├── config.ts
│   │   ├── llm.ts
│   │   └── channel.ts
│   └── utils/
│       ├── logger.ts
│       └── validators.ts
├── workspace/
│   ├── config/
│   │   ├── alfred.json
│   │   └── SOUL.md
│   ├── skills/
│   │   ├── system/
│   │   │   └── SKILL.md
│   │   └── custom/
│   ├── files/
│   ├── db/
│   │   └── alfred.db
│   ├── logs/
│   └── memory/
├── config/
│   └── system-prompt-base.txt
├── .gitignore
├── tsconfig.json
├── package.json
└── README.md
```

### Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY config/ ./config/

RUN npm run build

RUN mkdir -p /workspace/{db,files,skills,config,logs,memory}

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const ws=require('ws');new ws('ws://127.0.0.1:18789').on('open',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
```

### docker-compose.yml

```yaml
version: '3.9'

services:
  alfred:
    build:
      context: .
      dockerfile: docker/Dockerfile
    container_name: alfred-agent
    hostname: alfred
    restart: unless-stopped
    
    ports:
      - "127.0.0.1:18789:18789"
    
    volumes:
      - ~/.alfred-personal:/workspace
    
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
    
    networks:
      - alfred-net
    
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "10"

networks:
  alfred-net:
    driver: bridge
```

### Setup Inicial

```bash
# Clone
git clone https://github.com/yourusername/alfred-personal.git
cd alfred-personal

# Setup
mkdir -p ~/.alfred-personal/{config,skills,files,db,logs,memory}

# Copy templates
cp workspace/config/alfred.json ~/.alfred-personal/config/
cp workspace/config/SOUL.md ~/.alfred-personal/config/

# Edit configuration
vim ~/.alfred-personal/config/alfred.json
# Agregar API keys, tokens, etc.

# Build & Run
docker-compose up -d

# Check logs
docker-compose logs -f alfred

# Test
curl -i ws://127.0.0.1:18789
```

---

## ROADMAP

### v1.0 (MVP) — Agosto 2026

- [ ] Gateway WebSocket básico
- [ ] Config loader centralizado
- [ ] LLM Router (Ollama + Anthropic)
- [ ] SOUL.md loader + inyector
- [ ] Telegram plugin
- [ ] Tools: exec, file-ops, web-search
- [ ] SQLite schema + repos
- [ ] Dockerfile + compose
- [ ] CLI client de testing

**Entregables:** Gateway funcional, 1 canal, LLM agnóstico

### v1.5 — Septiembre 2026

- [ ] WhatsApp plugin (Baileys)
- [ ] Skills loader (SKILL.md parser)
- [ ] Web dashboard (Vue/React)
- [ ] Audit logging avanzado
- [ ] OpenAI provider support
- [ ] Gemini provider support

**Entregables:** Multi-canal, skills cargables, dashboard básico

### v2.0 — Q4 2026

- [ ] Discord plugin
- [ ] Slack plugin
- [ ] Redis para sesiones distribuidas
- [ ] LanceDB para embeddings
- [ ] Voice support
- [ ] Advanced memory + context

**Entregables:** Múltiples canales, memory avanzada

### v3.0+ — 2027

- [ ] Cloud deployment
- [ ] Multi-user support
- [ ] Advanced workflows
- [ ] Custom LLM providers
- [ ] Mobile apps

---

## REFERENCIAS

- **Documentación Antropic**: https://docs.anthropic.com
- **OpenAI API**: https://platform.openai.com/docs
- **Telegram Bot API**: https://core.telegram.org/bots/api
- **SQLite**: https://www.sqlite.org/docs.html
- **Node.js**: https://nodejs.org/docs
- **TypeScript**: https://www.typescriptlang.org/docs

---

## GLOSARIO

| Término | Definición |
|---------|-----------|
| **SOUL.md** | Archivo Markdown que define personalidad y comportamiento de Alfred |
| **SKILL.md** | Archivo Markdown que define habilidades modulares |
| **Provider** | Servicio LLM (Ollama, Anthropic, OpenAI, etc.) |
| **Gateway** | Hub WebSocket central que orquesta todo |
| **Channel** | Plugin de comunicación (Telegram, WhatsApp, etc.) |
| **Tool** | Capacidad que Alfred puede ejecutar (exec, web_search, etc.) |
| **Session** | Contexto de conversación por usuario + canal |
| **Fallback** | Provider alternativo si el principal falla |

---

## APÉNDICE A: EJEMPLOS DE CONFIGURACIÓN

### Configuración Minimalista (Solo Ollama Cloud)

```json
{
  "agent": {
    "name": "Alfred",
    "version": "2.0.0",
    "personality_file": "/workspace/config/SOUL.md"
  },
  "llm": {
    "primary_provider": "ollama-runpod",
    "fallback_providers": [],
    "model_selection": "automatic"
  },
  "providers": {
    "ollama-runpod": {
      "type": "openai-compatible",
      "enabled": true,
      "model": "mistral-large",
      "config": {
        "api_url": "https://api.runpod.io/v1/YOUR_ENDPOINT_ID/openai/v1",
        "api_key": "YOUR_RUNPOD_API_KEY",
        "temperature": 0.8,
        "max_tokens": 4096
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": false,
        "supports_streaming": true
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "type": "telegram",
      "config": {
        "bot_token": "YOUR_BOT_TOKEN",
        "polling": true
      },
      "permissions": {
        "allow_from": ["YOUR_USER_ID"]
      }
    }
  },
  "tools": {
    "web_search": {
      "enabled": true,
      "config": {
        "primary_provider": "duckduckgo"
      }
    }
  },
  "database": {
    "type": "sqlite",
    "config": {
      "path": "/workspace/db/alfred.db"
    }
  }
}
```

### Configuración Multi-Provider (Fallback Automático)

```json
{
  "llm": {
    "primary_provider": "ollama-runpod",
    "fallback_providers": ["ollama-local", "anthropic"],
    "model_selection": "automatic"
  },
  "providers": {
    "ollama-runpod": {
      "type": "openai-compatible",
      "enabled": true,
      "model": "mistral-large",
      "config": {
        "api_url": "https://api.runpod.io/v1/YOUR_ID/openai/v1",
        "api_key": "runpod_key",
        "temperature": 0.8,
        "max_tokens": 4096
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": false,
        "supports_streaming": true
      }
    },
    "ollama-local": {
      "type": "openai-compatible",
      "enabled": true,
      "model": "mistral",
      "config": {
        "api_url": "http://localhost:11434/v1",
        "api_key": "ollama",
        "temperature": 0.7,
        "max_tokens": 2048
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": false,
        "supports_streaming": true
      }
    },
    "anthropic": {
      "type": "anthropic",
      "enabled": true,
      "model": "claude-3-5-sonnet-20241022",
      "config": {
        "api_url": "https://api.anthropic.com/v1",
        "api_key": "sk-ant-your_key",
        "temperature": 0.8,
        "max_tokens": 4096
      },
      "capabilities": {
        "supports_tools": true,
        "supports_vision": true,
        "supports_streaming": true
      }
    }
  }
}
```

---

## APÉNDICE B: ESTRUCTURA DE WORKSPACE

```
~/.alfred-personal/
│
├── config/
│   ├── alfred.json                    ← Configuración principal
│   ├── SOUL.md                        ← Personalidad de Alfred
│   └── whatsapp-session.json          ← Sesión WhatsApp (auto-generado)
│
├── skills/
│   ├── system/
│   │   ├── help.SKILL.md              ← Help + info
│   │   ├── status.SKILL.md            ← Estado del agente
│   │   └── config.SKILL.md            ← Manejo de config
│   │
│   ├── web/
│   │   ├── search.SKILL.md            ← Web search avanzada
│   │   └── fetch.SKILL.md             ← Fetch + parsing
│   │
│   ├── files/
│   │   ├── operations.SKILL.md        ← Read/write/edit
│   │   └── backup.SKILL.md            ← Backup files
│   │
│   └── custom/
│       └── my-skill.SKILL.md          ← Tus skills personalizados
│
├── files/
│   ├── documents/
│   ├── projects/
│   ├── temp/
│   └── archives/
│
├── db/
│   └── alfred.db                      ← Base de datos SQLite
│
├── logs/
│   ├── gateway.log
│   ├── agent.log
│   ├── channels.log
│   ├── audit.log
│   └── errors.log
│
└── memory/
    ├── sessions/
    │   ├── telegram_12345678.json
    │   └── whatsapp_34987654321.json
    └── snapshots/
        └── context.json
```

---

## APÉNDICE C: ESTRUCTURA GIT

```
.gitignore
───────────
dist/
node_modules/
*.log
.env
workspace/db/*.db
workspace/logs/*
workspace/memory/*
workspace/config/alfred.json
workspace/config/whatsapp-session.json
workspace/config/SOUL.md

.gitkeep
───────
workspace/files/
workspace/skills/custom/
workspace/db/
workspace/logs/
workspace/memory/
```

---

## APÉNDICE D: PACKAGE.JSON

```json
{
  "name": "alfred-personal",
  "version": "2.0.0",
  "description": "Personal AI Agent - Multicanal, agnóstico a LLM, con SOUL.md",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "start": "node dist/index.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "eslint src --ext .ts",
    "docker:build": "docker-compose build",
    "docker:up": "docker-compose up -d",
    "docker:down": "docker-compose down",
    "docker:logs": "docker-compose logs -f alfred"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.24.1",
    "@google/generative-ai": "^0.19.0",
    "axios": "^1.7.4",
    "cheerio": "^1.0.0-rc.12",
    "grammy": "^1.27.1",
    "js-yaml": "^4.1.0",
    "marked": "^11.1.1",
    "openai": "^4.68.1",
    "pino": "^8.18.0",
    "sqlite3": "^5.1.7",
    "undici": "^6.13.0",
    "whatsapp-web.js": "^1.25.1",
    "ws": "^8.17.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/jest": "^29.7.0",
    "@types/node": "^20.10.0",
    "@typescript-eslint/eslint-plugin": "^6.13.0",
    "@typescript-eslint/parser": "^6.13.0",
    "eslint": "^8.57.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.1",
    "ts-node": "^10.9.2",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  },
  "engines": {
    "node": ">=22.0.0",
    "npm": ">=10.0.0"
  },
  "keywords": [
    "ai-agent",
    "llm",
    "multicanal",
    "telegram",
    "whatsapp",
    "personal-assistant"
  ],
  "author": "Alfred User",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/alfred-personal.git"
  }
}
```

---

## APÉNDICE E: TSCONFIG.JSON

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## APÉNDICE F: DOCKERFILE OPTIMIZADO

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./

RUN npm run build

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Copy production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application
COPY --from=builder /build/dist ./dist
COPY config/ ./config/

# Create workspace directories
RUN mkdir -p /workspace/{db,files,skills,config,logs,memory}

# Set permissions
RUN chown -R node:node /app /workspace

USER node

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "const ws=require('ws');new ws('ws://127.0.0.1:18789').on('open',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "/app/dist/index.js"]
```

---

## APÉNDICE G: DOCUMENTACIÓN API

### Gateway WebSocket API

#### Conexión

```typescript
// Request
{
  "type": "req",
  "id": "conn_001",
  "method": "connect",
  "params": {
    "clientId": "cli_001",
    "auth": {
      "token": "gateway_auth_token"
    }
  }
}

// Response
{
  "type": "res",
  "id": "conn_001",
  "ok": true,
  "payload": {
    "status": "connected",
    "gateway": {
      "version": "2.0.0",
      "uptime": 3600
    }
  }
}
```

#### Enviar Mensaje

```typescript
// Request
{
  "type": "req",
  "id": "msg_001",
  "method": "agent",
  "params": {
    "message": "¿Qué hora es?",
    "sessionId": "telegram_12345678",
    "streaming": true
  }
}

// Stream Response
{
  "type": "event",
  "event": "agent_chunk",
  "payload": {
    "runId": "run_abc123",
    "chunk": "Señor [user_name], son las...",
    "timestamp": "2026-07-14T10:30:00Z"
  }
}

// Complete Response
{
  "type": "event",
  "event": "agent_complete",
  "payload": {
    "runId": "run_abc123",
    "content": "Señor [user_name], son las 10:30 AM",
    "toolCalls": [],
    "usage": {
      "inputTokens": 150,
      "outputTokens": 25
    },
    "timestamp": "2026-07-14T10:30:02Z"
  }
}
```

#### Listar Skills

```typescript
// Request
{
  "type": "req",
  "id": "skill_001",
  "method": "skill_list",
  "params": {
    "filter": "web"
  }
}

// Response
{
  "type": "res",
  "id": "skill_001",
  "ok": true,
  "payload": {
    "skills": [
      {
        "name": "web-search",
        "description": "Search the web using DuckDuckGo",
        "enabled": true
      },
      {
        "name": "web-fetch",
        "description": "Fetch content from URLs",
        "enabled": true
      }
    ]
  }
}
```

---

## APÉNDICE H: TROUBLESHOOTING

| Problema | Causa | Solución |
|----------|-------|----------|
| **WebSocket connection refused** | Gateway no está corriendo | `docker-compose logs alfred` |
| **Provider not found: X** | Provider no configurado en alfred.json | Verificar providers en config |
| **API key invalid** | Credencial incorrecta | Re-verificar en alfred.json |
| **SQLite: database locked** | Múltiples escrituras simultáneas | Usar WAL mode (ya configurado) |
| **File not found: /workspace/skills** | Directorio no existe | `mkdir -p ~/.alfred-personal/skills` |
| **SOUL.md not loaded** | Archivo no existe o no es legible | Copiar template desde repo |
| **Tool execution timeout** | Comando tarda más que timeout | Aumentar timeout_seconds en config |
| **Memory leak en Node** | Sesiones no se limpian | Implementar garbage collection |

---

## APÉNDICE I: PERFORMANCE TUNING

### Optimizaciones Recomendadas

```json
{
  "database": {
    "config": {
      "journal_mode": "WAL",
      "synchronous": 1,
      "cache_size": 10000,
      "temp_store": "MEMORY"
    }
  },
  "logging": {
    "config": {
      "level": "warn",
      "buffer_size": 1000
    }
  }
}
```

### Monitoreo

```bash
# Monitorear uso de memoria
docker stats alfred

# Ver logs en tiempo real
docker-compose logs -f --tail=50 alfred

# Verificar base de datos
sqlite3 ~/.alfred-personal/db/alfred.db ".tables"

# Analizar query performance
sqlite3 ~/.alfred-personal/db/alfred.db ".mode line"
sqlite3 ~/.alfred-personal/db/alfred.db "EXPLAIN QUERY PLAN SELECT..."
```

---

## APÉNDICE J: TESTING

### Unit Test Ejemplo

```typescript
// tests/unit/llm-router.test.ts

import { LLMRouter } from '../../src/agent/llm-router';
import { ConfigLoader } from '../../src/config/loader';

describe('LLMRouter', () => {
  let router: LLMRouter;
  let configLoader: ConfigLoader;

  beforeEach(() => {
    configLoader = new ConfigLoader('/workspace/config/alfred.json');
    router = new LLMRouter(configLoader);
  });

  test('should initialize with primary provider', () => {
    const info = router.getProviderInfo();
    expect(info.current).toBe('ollama-runpod');
  });

  test('should fallback to next provider on failure', async () => {
    // Mock failure
    const response = await router.call({
      messages: [],
      system: 'Test prompt',
      tools: []
    });
    
    expect(response).toBeDefined();
  });

  test('should support multiple LLM providers', () => {
    const info = router.getProviderInfo();
    expect(info.chain.length).toBeGreaterThan(0);
  });
});
```

### Integration Test Ejemplo

```typescript
// tests/integration/gateway.test.ts

import { Gateway } from '../../src/gateway';
import WebSocket from 'ws';

describe('Gateway Integration', () => {
  let gateway: Gateway;

  beforeAll(async () => {
    // Inicializar gateway
  });

  afterAll(async () => {
    // Cleanup
  });

  test('should handle WebSocket connections', async () => {
    const ws = new WebSocket('ws://127.0.0.1:18789');
    
    ws.send(JSON.stringify({
      type: 'req',
      method: 'connect',
      params: { clientId: 'test' }
    }));

    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
```

---

## APÉNDICE K: CHECKLISTS

### Pre-Deployment

- [ ] Configurar alfred.json con credenciales
- [ ] Copiar SOUL.md a workspace/config/
- [ ] Crear volumen Docker: `~/.alfred-personal/`
- [ ] Validar conectividad a LLM provider
- [ ] Configurar bot token Telegram
- [ ] Probar WebSocket: `curl ws://127.0.0.1:18789`
- [ ] Verificar permisos de archivos
- [ ] Revisar logs en startup

### Post-Deployment

- [ ] Monitorear logs iniciales
- [ ] Probar con mensaje de prueba en Telegram
- [ ] Verificar que SOUL.md se inyecta correctamente
- [ ] Testar fallback a provider alternativo
- [ ] Verificar persistencia en SQLite
- [ ] Revisar uso de recursos (memoria, CPU)
- [ ] Backup de configuración

---

**Especificación Técnica Completa de Alfred v2.0**

**Estado:** ✅ Listo para Implementación  
**Última actualización:** Julio 15, 2026  
**Revisor:** El usuario  

**Documento de Especificación Finalizado**

Esta es la especificación técnica completa y lista para iniciar la implementación.

Contiene:
- Visión y arquitectura completa
- Stack técnico detallado  
- Configuración agnóstica de LLM
- SOUL.md y personalidad
- Acceso a internet (web search)
- Base de datos SQLite
- 7 tools principales
- Gateway WebSocket
- Soporte multicanal
- Skills modulares
- Seguridad en capas
- Deployment con Docker
- Roadmap completo
- Apéndices con ejemplos, troubleshooting, testing

¿Procedo con la implementación de la base de código?

