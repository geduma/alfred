# ALFRED — Quick Start Guide

**Versión:** 2.0.0  
**Para:** Señor Felipe  

---

## 30 SEGUNDOS

**Alfred** es tu asistente IA personal que:
- Se comunica via Telegram/WhatsApp
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
mkdir -p ~/.alfred-personal/{config,skills,files,db,logs,memory}

# 3. Configure (edit with your API keys + Telegram token)
cp workspace/config/alfred.json ~/.alfred-personal/config/
vim ~/.alfred-personal/config/alfred.json

# 4. Copy SOUL.md (personalidad)
cp workspace/config/SOUL.md ~/.alfred-personal/config/

# 5. Run
docker-compose up -d

# 6. Check logs
docker-compose logs -f alfred
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

### Próxima Versión (v1.5)
✅ WhatsApp  
✅ Dashboard web  
✅ Skills personalizados  

### v2.0
✅ Discord/Slack  
✅ Llamadas por voz  
✅ Embeddings + búsqueda semántica  

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
- Te trata como "Señor Felipe"
- Refinado pero directo

Edit `/workspace/config/SOUL.md` para cambiar.

---

## ARCHIVOS IMPORTANTES

```
~/.alfred-personal/
├── config/
│   ├── alfred.json        ← Configuración principal
│   ├── SOUL.md            ← Personalidad de Alfred
│
├── files/                 ← Tus archivos (puede leer/escribir)
├── skills/                ← Skills personalizados (.md)
├── db/
│   └── alfred.db          ← Base de datos (conversaciones, audit)
└── logs/                  ← Logs de auditoría
```

---

## MONITOREO

```bash
# Ver logs en tiempo real
docker-compose logs -f alfred

# Estado del contenedor
docker-compose ps

# Estadísticas de recursos
docker stats alfred

# Conectarse a BD
sqlite3 ~/.alfred-personal/db/alfred.db

# Verificar configuración
cat ~/.alfred-personal/config/alfred.json | jq
```

---

## TROUBLESHOOTING

| Problema | Solución |
|----------|----------|
| WebSocket error | `docker-compose logs alfred` |
| Provider no conecta | Verificar API key en alfred.json |
| Telegram no responde | Verificar bot_token y allow_from |
| Archivo no se crea | Verificar permisos en `/workspace/files` |

---

## DOCUMENTACIÓN COMPLETA

Ver `ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md` para:
- Arquitectura detallada
- Todas las opciones de configuración
- API WebSocket
- Development guide
- Troubleshooting exhaustivo

---

## PRÓXIMOS PASOS

1. ✅ Setup inicial (arriba)
2. 📝 Personalizar `SOUL.md` si deseas
3. 💬 Envía mensaje via Telegram
4. 🎯 Alfred responde como si fuera tu asistente personal
5. 🚀 Agregar skills/plugins según necesites

---

**¿Listo para comenzar, Señor Felipe?**

El archivo `ALFRED_ESPECIFICACION_TECNICA_COMPLETA.md` contiene todo lo que necesitas saber.

