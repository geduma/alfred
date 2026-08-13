---
name: voice-notes
description: Voice notes (STT) and spoken replies (TTS) through any OpenAI-compatible audio API
tools: exec, file_ops
metadata:
  requires:
    bins: []
    env: []
---

## Overview

Alfred integrates voice through **any service compatible with the OpenAI audio API**
(`POST /v1/audio/transcriptions` for STT, `POST /v1/audio/speech` for TTS). The concrete
provider (self-hosted or cloud) is configured in `alfred.json`, section `voice`. Alfred only
speaks HTTP following the OpenAI convention, so it is agnostic to both provider and channel.

- **Input (STT):** a Telegram voice note is downloaded, transcribed, and the text enters
  Alfred's normal pipeline.
- **Output (TTS):** if `reply_mode: voice` in `preferences.md` (or the user explicitly asks
  for audio), the reply is synthesized and sent as audio + text.

The automatic STT/TTS implementation is **code-driven** (the `VoiceService`), not orchestrated
via tools. This skill covers on-demand behavior, configuration, and manual verification.

## When to use

- Automatic: the user sends a voice note → it is transcribed on its own. No model action required.
- Automatic: `reply_mode: voice` in `preferences.md` → always reply with audio + text.
- **On demand:** the user asks for an audio reply ("send it to me as audio", "reply by voice").
  The model must signal this with the `[AUDIO]` marker (see protocol below).

## How to use

### On-demand protocol — `[AUDIO]` marker

Works at any time, regardless of `reply_mode`, when `voice.tts.expose_to_model` is `true` in
`alfred.json`:

1. The user explicitly asks for an audio reply.
2. At the end of your reply, add a final line containing exactly `[AUDIO]`.
3. The Telegram channel detects the marker, removes it from the text, synthesizes the rest,
   and sends **audio + text**.
4. Do not use `[AUDIO]` unless voice is requested, nor in channels that do not support it
   (CLI/web).

Example reply with audio:

```
Sure, here's your summary for the day: two overdue reminders and the system is healthy.
[AUDIO]
```

### Where to find the voice provider URL

**Do not assume any provider URL.** The base URL and API key live in the Alfred configuration:

- Config file: `alfred.json` under the workspace `config/` directory
  (e.g. `/workspace/config/alfred.json` inside Docker).
- Keys:
  - `voice.provider.api_url` — default base URL (all paths below are appended to it).
  - `voice.stt.provider.api_url` — overrides the base URL for transcription only.
  - `voice.tts.provider.api_url` — overrides the base URL for synthesis only.
  - `voice.provider.api_key` (and the per-STT/TTS overrides) — optional, sent as `Bearer`
    only when non-empty.

Read the actual values from `alfred.json` (e.g. with `cat` via `exec`) before calling any
endpoint. Provider-specific values such as model names and voice identifiers are also read
from `alfred.json` (`voice.stt.model`, `voice.tts.model`, `voice.tts.voice`) or discovered
from the provider itself.

### Configuration — `alfred.json`

Any OpenAI-compatible provider. `stt.provider` and `tts.provider` take precedence over
`voice.provider`, allowing STT and TTS to use different providers. Replace the placeholders
below with values from the configured provider; the URL must be copied from the actual config,
not invented.

```json
{
  "voice": {
    "enabled": true,
    "timeout_seconds": 60,
    "provider": { "api_url": "<VOICE_BASE_URL>", "api_key": "" },
    "stt": { "model": "<STT_MODEL>", "language": "auto" },
    "tts": { "model": "<TTS_MODEL>", "voice": "<TTS_VOICE>", "response_format": "wav", "expose_to_model": true }
  }
}
```

Model and voice identifiers are provider-specific; list them from the provider once you know
its base URL: `GET <VOICE_BASE_URL>/models`.

Output preference in `preferences.md`:

```
reply_mode: txt        # txt (default) | voice — voice = always reply with audio + text
```

### Manual verification (exec + curl)

1. Read the real base URL from `alfred.json` → `voice.provider.api_url` (or the STT/TTS
   overrides), e.g.:

   ```bash
   cat /workspace/config/alfred.json
   ```

2. Export it as `VOICE_API_URL` and verify the provider responds:

   ```bash
   VOICE_API_URL="<base_url_from_config>"
   curl -s "${VOICE_API_URL}/health"
   ```

3. List models (OpenAI-compatible, with Bearer if there is a key):

   ```bash
   curl -s "${VOICE_API_URL}/models"
   ```

4. Manual STT (OpenAI-compatible):

   ```bash
   curl -s "${VOICE_API_URL}/audio/transcriptions" \
     -F "file=@/workspace/files/sample.ogg" \
     -F "model=<stt_model_from_config>"
   ```

5. Manual TTS:

   ```bash
   curl -s "${VOICE_API_URL}/audio/speech" \
     -H "Content-Type: application/json" \
     -d '{"model":"<tts_model_from_config>","voice":"<tts_voice_from_config>","input":"Hello there"}' \
     -o /workspace/files/sample.wav
   ```

> Note: `exec` only allows the patterns in `tools.exec.allowed_patterns` (must include
> `curl`). Avoid `jq` unless it is in the list; parse the JSON by hand.

## Error handling

- **Service unavailable or timeout:** Alfred degrades to text (replies without audio) and logs
  it. Do not block the conversation because of a voice failure.
- **Invalid audio:** transcription fails → Alfred replies "I could not understand the audio."
  without going through the pipeline.
- **`[AUDIO]` ignored:** if `expose_to_model` is `false`, the marker is ignored and the reply
  is text-only.

## Summary

The complexity (models, hardware, provider API) is isolated in the audio service. Alfred only
sends/receives HTTP following the OpenAI convention and orchestrates the pipeline. This skill
provides the on-demand protocol (`[AUDIO]`), the multi-provider configuration, and manual
verification, always reading the actual provider URL from `alfred.json`.
