# ALFRED — Quick Start Guide

**Versión:** 2.1.0  
**Para:** El usuario  

---

## 30 SEGUNDOS

**Alfred** es tu asistente IA personal que:
- Se comunica via Telegram y CLI
- Lee y escribe en tus archivos
- Busca en internet
- Entiende tu tono (SOUL.md)
- Usa cualquier LLM (Ollama cloud, Anthropic, OpenAI, etc.)
- Todo en UN contenedor Docker

---

## SETUP (5 MINUTOS)

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

## CONFIGURACIÓN MÍNIMA

Edita `~/.alfred-personal/config/alfred.json`:

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

**¡Eso es!** El resto está auto-configurado.

---

## ¿QUÉ PUEDES HACER?

### Inmediato
✅ Chat via Telegram  
✅ Preguntas (Alfred busca en internet)  
✅ Leer/escribir archivos en `/workspace/files/`  
✅ Ejecutar comandos shell  

### v1.5
✅ Skills personalizados — SKILL.md via `file_ops`

### v2.0
✅ Embeddings + búsqueda semántica (LanceDB RAG)  
✅ Health monitor — detección automática de fallos y alertas por Telegram  
❌ Discord/Slack — roadmap (no implementado)  
❌ Llamadas por voz — roadmap (no implementado)

---

## CAMBIAR LLM

¿Quieres cambiar de Ollama a Anthropic?

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

Reinicia Alfred. **Eso es.**

---

## PERSONALIDAD (SOUL.md)

Tu asistente siempre responde como Alfred Pennyworth:
- Español latinoamericano
- Elegante y preciso
- Te trata como "Señor [user_name]"
- Refinado pero directo

Edit `/workspace/config/SOUL.md` para cambiar.

---

## ARCHIVOS IMPORTANTES

```
~/.alfred-personal/
├── config/
│   ├── alfred.json        ← Configuración principal
│   ├── SOUL.md            ← Personalidad de Alfred
│   ├── secrets.env        ← Secretos para skills (IMAP, APIs, etc.)
│
├── files/                 ← Tus archivos (puede leer/escribir)
├── skills/
│   └── custom/            ← Skills personalizados (SKILL.md)
├── db/
│   └── alfred.db          ← Base de datos (conversaciones, audit)
└── logs/                  ← Logs de auditoría
```

---

## MONITOREO

```bash
# Ver logs en tiempo real
docker compose -f docker/docker-compose.yml logs -f alfred

# Estado del contenedor
docker compose -f docker/docker-compose.yml ps

# Estadísticas de recursos
docker stats alfred

# Conectarse a BD
sqlite3 ~/.alfred-personal/db/alfred.db

# Verificar configuración
cat ~/.alfred-personal/config/alfred.json | jq
```

### Health Monitor automático

Alfred escanea sus propios logs cada 60 minutos. Si detecta errores repetidos, envía una alerta por Telegram.

**Comandos disponibles** (via Telegram o CLI):
- `health findings` — ver todos los hallazgos recientes
- `health findings severity=error` — solo errores graves
- `health check` — forzar escaneo inmediato
- `health status` — estado del monitor

---

## TROUBLESHOOTING

| Problema | Solución |
|----------|----------|
| WebSocket error | `docker compose -f docker/docker-compose.yml logs alfred` |
| Provider no conecta | Verificar API key en alfred.json |
| Telegram no responde | Verificar bot_token y allow_from |
| Archivo no se crea | Verificar permisos en `/workspace/files` |
| Vector store falla | Verificar que haya suficiente RAM disponible o deshabilitar `memory.vector_store.enabled: false` |
| Health alert sin mensaje | Verificar `health_monitor.severity_threshold` — con `"warn"` captura todo, con `"error"` solo graves |

---

## DOCUMENTACIÓN COMPLETA

La documentación técnica vive en el repositorio:

- `README.md` — Inicio, setup, arquitectura y deployment
- `docs/PRD.md` — Requisitos de producto
- `docs/AGENTS.md` — Instrucciones para agentes IA / developers
- `docs/PROGRESS.md` — Progreso de implementación
- `system/alfred-rules.md` — Reglas inyectadas en el system prompt

---

## PRÓXIMOS PASOS

1. ✅ Setup inicial (arriba)
2. 📝 Personalizar `SOUL.md` si deseas
3. 💬 Envía mensaje via Telegram
4. 🎯 Alfred responde como si fuera tu asistente personal
5. 🚀 Agregar skills/plugins según necesites

---

**¿Listo para comenzar?**

Empieza por `README.md` y `docs/AGENTS.md` — contienen todo lo que necesitas saber.

