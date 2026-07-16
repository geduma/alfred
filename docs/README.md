# 🎩 ALFRED — Agente IA Personal Multicanal

**Especificación Técnica Completa v2.0**

**Para:** Señor Felipe  
**Versión:** 2.0.0  
**Fecha:** Julio 2026  
**Estado:** ✅ **Listo para Implementación**

---

## 📥 DESCARGAR DOCUMENTACIÓN

Todos los archivos están disponibles en esta carpeta. **Descarga estos documentos:**

### 📄 DOCUMENTOS PRINCIPALES (REQUERIDO)

1. **ALFRED_DOCUMENTACION_INDEX.md** (8.8 KB)
   - Índice de toda la documentación
   - Guía de qué leer según tu rol
   - Matriz de decisiones arquitectónicas
   - Checklist de implementación

2. **ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md** (63 KB) ⭐⭐⭐
   - Especificación técnica completa
   - Arquitectura, stack, configuración
   - 15 secciones + 10 apéndices
   - TODO lo que necesitas para implementar

3. **ALFRED_QUICK_START.md** (4.2 KB)
   - Setup rápido en 5 minutos
   - Configuración mínima
   - Para comenzar YA

### 📚 DOCUMENTOS DE REFERENCIA (Historial)

4. **ALFRED_CONFIG_ARCH.md** (23 KB)
   - Arquitectura de configuración centralizada
   - Config Loader + Provider Factory
   - LLM Router agnóstico

5. **ALFRED_LLM_WEBSEARCH.md** (24 KB)
   - Implementación de LLM Router
   - Soporte multi-provider
   - Web search alternativas gratuitas

6. **ALFRED_SPEC_v2.md** (39 KB)
   - Segunda iteración del spec
   - Incluye SOUL.md y database

---

## 🚀 POR DÓNDE EMPEZAR

### Opción A: Implementación Rápida ⚡
```
1. Lee: ALFRED_QUICK_START.md (5 min)
2. Descarga especificación completa
3. Haz setup Docker (5 min)
4. ¡Listo!
```

### Opción B: Entendimiento Profundo 🧠
```
1. Lee: ALFRED_DOCUMENTACION_INDEX.md
2. Lee: VISIÓN EJECUTIVA de especificación
3. Lee: ARQUITECTURA GENERAL
4. Luego: Componentes específicos según necesites
```

### Opción C: Implementación Profesional 🏢
```
1. DOCUMENTACION_INDEX.md (navegación)
2. ESPECIFICACION_TECNICA_COMPLETA.md (completo)
3. Apéndices D-G (código de ejemplo)
4. Comienza implementación fase por fase
```

---

## 📋 RESUMEN EJECUTIVO

### ¿Qué es Alfred?

Un asistente IA personal que:
- ✅ Se comunica via **Telegram + WhatsApp**
- ✅ Lee y escribe en tus **archivos**
- ✅ Busca en **internet** automáticamente
- ✅ Usa **cualquier LLM** (Ollama, Anthropic, OpenAI, etc.)
- ✅ Tiene **personalidad persistente** (SOUL.md)
- ✅ Todo en **un solo contenedor Docker**
- ✅ **100% open-source** y gratis

### ¿Por qué Alfred?

**Antes (sin Alfred):**
```
Cambiar de LLM → Modificar código → Recompilar → Deploy
```

**Con Alfred:**
```
Editar alfred.json → Reiniciar → ¡Funciona!
```

---

## ⚙️ CARACTERÍSTICAS PRINCIPALES

| Característica | Descripción | Estado |
|---|---|---|
| **LLM Agnóstico** | Cambiar entre Ollama, Anthropic, OpenAI sin código | ✅ |
| **Multicanal** | Telegram (v1), WhatsApp (v1.5), Discord (v2) | ✅ Diseño |
| **Personalidad** | SOUL.md define tono, valores, límites | ✅ |
| **Web Search** | DuckDuckGo + Bing (fallback) | ✅ |
| **Acceso Archivos** | Leer/escribir en `/workspace/files/` | ✅ |
| **Single Container** | Todo en Docker, SQLite embebido | ✅ |
| **Fallback Automático** | Si LLM falla, intenta siguiente provider | ✅ |
| **Skills Modulares** | SKILL.md cargables sin recompilación | ✅ |

---

## 🏗️ ARQUITECTURA

```
┌─────────────────────────────────────┐
│  Telegram / WhatsApp / Discord      │
└─────────────────────┬───────────────┘
                      │
┌─────────────────────▼───────────────┐
│  Gateway WebSocket (18789)          │
│  • Session Manager                  │
│  • Message Router                   │
└─────────────────────┬───────────────┘
                      │
┌─────────────────────▼───────────────┐
│  Agent Runtime                      │
│  • SOUL.md Loader                   │
│  • Prompt Builder                   │
│  • LLM Router (Agnóstico)           │
└─────────────────────┬───────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
    ┌───▼──┐    ┌────▼────┐    ┌──▼────┐
    │Ollama│    │Anthropic│    │ Gemini│
    │Cloud │    │ Claude  │    │       │
    └──────┘    └─────────┘    └───────┘
    
    (+ Fallback automático)
```

---

## 📊 STACK TÉCNICO

- **Runtime:** Node.js 22 LTS
- **Language:** TypeScript 5.4+
- **Database:** SQLite 3 (embebido)
- **WebSocket:** ws@8.17
- **LLM SDK:** @anthropic-ai/sdk + openai package
- **Telegram:** grammy@1.27
- **WhatsApp:** whatsapp-web.js@1.25
- **Web Search:** axios + cheerio
- **Logging:** pino@8.18
- **Docker:** node:22-alpine (~180MB)

**Costo total:** $0 (todo open-source)

---

## 🎯 CONFIGURACIÓN CENTRALIZADA

**Un solo archivo: `alfred.json`**

```json
{
  "llm": {
    "primary_provider": "ollama-runpod",
    "fallback_providers": ["anthropic"]
  },
  "providers": {
    "ollama-runpod": {
      "type": "openai-compatible",
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
      "config": { "bot_token": "YOUR_TOKEN" }
    }
  }
}
```

**No más .env. No más variables hardcodeadas. Todo centralizado.**

---

## 🔐 SEGURIDAD

- Gateway auth token
- Tool policy (allowlist/denylist)
- Channel ACL (whitelist de usuarios)
- File access confinado a `/workspace/files`
- Audit logging de todos los comandos
- Rate limiting por usuario

---

## 📦 DEPLOYMENT

```bash
# Setup (5 min)
git clone <repo>
cd alfred-personal
mkdir -p ~/.alfred-personal/{config,skills,files,db,logs,memory}
cp workspace/config/alfred.json ~/.alfred-personal/config/
vim ~/.alfred-personal/config/alfred.json  # Editar API keys

# Run
docker-compose up -d

# Check
docker-compose logs -f alfred
```

---

## 🗺️ ROADMAP

### v1.0 (MVP) — Agosto 2026
- Gateway WebSocket
- LLM Router agnóstico
- Telegram plugin
- Tools básicos (exec, file_ops, web_search)
- SQLite

### v1.5 — Septiembre 2026
- WhatsApp plugin
- Skills loader
- Web dashboard
- OpenAI + Gemini support

### v2.0 — Q4 2026
- Discord + Slack
- Redis sessions
- LanceDB embeddings
- Voice support

### v3.0+ — 2027
- Cloud deployment
- Multi-user
- Advanced workflows
- Mobile apps

---

## 📖 DOCUMENTACIÓN

**Archivo Principal:**
- `ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md`
  - 15 secciones
  - 10 apéndices
  - 400+ KB de referencia

**Inicio Rápido:**
- `ALFRED_QUICK_START.md`
  - Setup en 5 minutos
  - Cambiar LLM
  - Troubleshooting rápido

**Navegación:**
- `ALFRED_DOCUMENTACION_INDEX.md`
  - Índice de todos los documentos
  - Guía por rol (developer, architect, user)
  - Matriz de decisiones

---

## 💡 EJEMPLOS RÁPIDOS

### Cambiar LLM

```json
{
  "llm": { "primary_provider": "anthropic" }
}
```

Reinicia. **¡Listo!**

### Agregar Fallback

```json
{
  "llm": {
    "fallback_providers": ["ollama-local", "anthropic"]
  }
}
```

Si Ollama cloud cae → intenta local → intenta Anthropic automáticamente.

### Personalizar Tono

Edita `/workspace/config/SOUL.md`:

```markdown
## Communication Style
- Más formal → Cambiar "Refined sarcasm" a "Professional"
- Más casual → Cambiar "discreet" a "friendly"
```

---

## 🛠️ PARA DEVELOPERS

**Estructura de Proyecto:**
```
src/
├── index.ts           ← Punto entrada
├── gateway.ts         ← WebSocket hub
├── agent/             ← Agent runtime
├── tools/             ← exec, web-search, etc.
├── channels/          ← Telegram, WhatsApp, etc.
├── db/                ← SQLite
├── config/            ← Config loader
└── types/             ← TypeScript interfaces
```

**Implementación:**
1. Config Loader
2. LLM Router
3. Gateway WebSocket
4. Agent Runtime
5. Telegram Plugin
6. Tools
7. SQLite Persistence

**Testing:**
- Unit tests (jest)
- Integration tests
- E2E tests

---

## ❓ PREGUNTAS FRECUENTES

**P: ¿Cuánto cuesta?**
R: $0. Stack 100% open-source. Solo pagas si usas API de pago (Anthropic, OpenAI).

**P: ¿Puedo usar Ollama local?**
R: Sí. Configura en `alfred.json` como primary provider.

**P: ¿Puedo cambiar el idioma?**
R: Sí. Edita `SOUL.md` y `system-prompt-base.txt`.

**P: ¿Funciona offline?**
R: Sí, si usas Ollama local. No con APIs cloud.

**P: ¿Puedo agregar más canales?**
R: Sí. Implementa nuevo plugin en `src/channels/`.

**P: ¿Dónde guardan los datos?**
R: En `~/.alfred-personal/`. Todo local.

**P: ¿Es seguro?**
R: Sí. Gateway auth, ACL, audit logging, sandbox.

---

## 📞 SOPORTE

**Problemas:** Ver `ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md` → Apéndice H: Troubleshooting

**Dudas técnicas:** Ver índice de documentación para componente específico

**Setup:** ALFRED_QUICK_START.md

---

## ✅ CHECKLIST FINAL

Antes de comenzar:
- [ ] Descargué ALFRED_DOCUMENTACION_INDEX.md
- [ ] Descargué ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md
- [ ] Descargué ALFRED_QUICK_START.md
- [ ] Tengo Node.js 22+ y Docker
- [ ] Tengo API key de LLM (Ollama cloud, Anthropic, etc.)
- [ ] Tengo Telegram bot token

¡Listo! Comienza con `ALFRED_QUICK_START.md`.

---

## 🚀 ¡COMENZAR!

**Paso 1:** Lee `ALFRED_QUICK_START.md` (5 min)

**Paso 2:** Ejecuta:
```bash
git clone <repo>
cd alfred-personal
docker-compose up -d
```

**Paso 3:** Envía mensaje en Telegram

**Paso 4:** ¡Alfred responde!

---

**Especificación Técnica Completa de Alfred v2.0**

**Preparado para Señor Felipe**

Versión: 2.0.0  
Fecha: Julio 2026  
Estado: ✅ Completo y Listo para Implementación

---

## 📥 ARCHIVOS A DESCARGAR

```
ALFRED_DOCUMENTACION_INDEX.md            (8.8 KB)  ← EMPIEZA AQUÍ
ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md (63 KB)  ← REFERENCIA PRINCIPAL
ALFRED_QUICK_START.md                    (4.2 KB)  ← SETUP RÁPIDO
ALFRED_CONFIG_ARCH.md                    (23 KB)   ← Referencia
ALFRED_LLM_WEBSEARCH.md                  (24 KB)   ← Referencia
ALFRED_SPEC_v2.md                        (39 KB)   ← Referencia
```

**Total:** ~161 KB de documentación completa

---

**¿Listo para comenzar, Señor Felipe?** 🎩

