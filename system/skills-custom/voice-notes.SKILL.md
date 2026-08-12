---
name: voice-notes
description: Notas de voz (STT) y respuestas habladas (TTS) vía proveedores compatibles con la API de audio de OpenAI
tools: exec, file_ops
metadata:
  requires:
    bins: []
    env: []
---

## Overview

Alfred integra voz mediante **cualquier servicio compatible con la API de audio de OpenAI**
(`POST /v1/audio/transcriptions` para STT, `POST /v1/audio/speech` para TTS). El servicio
concreto (Speaches, Groq, OpenAI, un proxy local, etc.) se configura en `alfred.json`,
sección `voice`. Alfred solo habla HTTP con la convención OpenAI, así que es agnóstico al
proveedor y al canal.

- **Entrada (STT):** una nota de voz de Telegram se descarga, se transcribe y el texto entra
  al pipeline normal de Alfred.
- **Salida (TTS):** si `voice_replies: always` (o el usuario pide audio explícitamente),
  la respuesta se sintetiza y se envía como audio + texto.

La implementación STT/TTS automática es **code-driven** (servicio `VoiceService`), no se
orquesta vía tools. Esta skill cubre el comportamiento bajo demanda, la configuración y la
verificación manual.

## When to use

- Automático: el usuario envía una nota de voz → se transcribe sola. No requiere acción del modelo.
- Automático: `voice_replies: always` en `preferences.md` → responde siempre con audio + texto.
- **Bajo demanda:** el usuario pide la respuesta en audio ("mándamelo en audio", "contéstame por voz").
  Ahí el modelo debe señalarlo con el marcador `[AUDIO]` (ver protocolo abajo).

## How to use

### Protocolo bajo demanda — marcador `[AUDIO]`

Solo cuando `voice.tts.expose_to_model` está en `true` en `alfred.json`:

1. El usuario pide explícitamente una respuesta en audio.
2. Al final de tu respuesta, añade una línea final que contenga exactamente `[AUDIO]`.
3. El canal Telegram detecta el marcador, lo elimina del texto, sintetiza el resto y envía
   **audio + texto**.
4. No uses `[AUDIO]` si no se pide voz, ni en canales que no lo soporten (CLI/web).

Ejemplo de respuesta con audio:

```
Claro, aquí tienes el resumen del día: dos recordatorios vencidos y el sistema sano.
[AUDIO]
```

### Configuración — `alfred.json`

Cualquier proveedor OpenAI-compatible. `api_key` es opcional (se envía como Bearer solo si
no está vacía). `stt.provider` y `tts.provider` tienen prioridad sobre `voice.provider`,
permitiendo STT y TTS de proveedores distintos.

```json
{
  "voice": {
    "enabled": true,
    "timeout_seconds": 60,
    "provider": { "api_url": "http://speaches.home/v1", "api_key": "" },
    "stt": { "model": "Systran/faster-whisper-base", "language": "auto" },
    "tts": { "model": "speaches-ai/piper-es_MX-ald-medium", "voice": "ald", "response_format": "wav", "expose_to_model": true }
  }
}
```

Ejemplos de proveedores (solo cambian `api_url`/`api_key`/modelos):

| Proveedor | STT (modelo) | TTS (modelo/voz) |
| --- | --- | --- |
| Speaches (homelab) | `Systran/faster-whisper-base` | `speaches-ai/piper-es_MX-ald-medium` / `ald` |
| OpenAI | `whisper-1` | `tts-1` / `alloy` |
| Groq | `whisper-large-v3-turbo` | `playai-tts` / voz del modelo |

Preferencia de salida en `preferences.md`:

```
voice_replies: never        # o "always"
```

### Verificación manual (exec + curl)

Comprobar que el proveedor responde:

```bash
curl -s http://speaches.home/health
```

Listar modelos (OpenAI-compatible, con Bearer si hay key):

```bash
curl -s http://speaches.home/v1/models
```

STT manual (OpenAI-compatible):

```bash
curl -s http://speaches.home/v1/audio/transcriptions \
  -F "file=@/workspace/files/prueba.ogg" \
  -F "model=Systran/faster-whisper-base"
```

TTS manual:

```bash
curl -s http://speaches.home/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"speaches-ai/piper-es_MX-ald-medium","voice":"ald","input":"Hola señor"}' \
  -o /workspace/files/prueba.wav
```

> Nota: `exec` solo permite los patrones de `tools.exec.allowed_patterns` (debe incluir
> `curl`). Evita `jq` si no está en la lista; parsea el JSON a mano.

## Error handling

- **Servicio no disponible o timeout:** Alfred degrada a texto (responde sin audio) y lo
  registra en el log. No bloquear la conversación por fallo de voz.
- **Audio inválido:** la transcripción falla → Alfred responde "No pude entender el audio."
  sin pasar por el pipeline.
- **`[AUDIO]` ignorado:** si `expose_to_model` es `false`, el marcador se ignora y se
  responde solo en texto.

## Resumen

La complejidad (modelos, hardware, API del proveedor) queda aislada en el servicio de audio.
Alfred solo envía/recibe HTTP según la convención OpenAI y orquesta el pipeline. La skill
aporta el protocolo bajo demanda (`[AUDIO]`), la configuración multi-proveedor y la
verificación manual.
