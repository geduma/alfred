# Plan — 001 voice-mirror

## Archivos a tocar
1. `src/channels/telegram.ts` — `shouldSynthesizeVoice(response, inputType)` + envío con `sendVoice` + action `upload_voice`.
2. `system/skills-custom/voice-notes.skill.md` — actualizar protocolo: mirror por defecto + overrides `[AUDIO]`/`[TEXT]`.
3. `tests/unit/telegram-voice-mirror.test.ts` (nuevo) — matriz default + overrides + limpieza de marcadores.

## Diseño
- `shouldSynthesizeVoice(response, inputType)` (sin regex de idioma en código: el override lo decide el modelo con marcadores):
  - Limpia el bloque final de marcadores; si hay varios, gana el último.
  - Marcador explícito + `expose_to_model=true` ⇒ manda (AUDIO=voz, TEXT=texto).
  - Sin marcador (o `expose_to_model=false`) ⇒ mirror: `voice→voz`, `text→texto`.
  - Sin `voiceService` ⇒ siempre texto (con marcadores limpios).
  - El override ("pídeme lo contrario en la conversación", en cualquier idioma) lo interpreta el LLM vía skill y lo señala con el marcador; el código no contiene patrones en español ni en ningún otro idioma.
- Envío: `sendVoice(chatId, new InputFile(audio,'alfred.ogg'), {caption})` con `sendChatAction('upload_voice')`. Fallback a texto si TTS falla.
- Sin cambios en gateway ni STT.

## Riesgos
- Telegram prefiere ogg/opus para `sendVoice`; enviamos wav con nombre `.ogg`. La API suele aceptarlo, y si falla el fallback a texto cubre. Alternativa futura: pedir `response_format: opus/ogg` a Speaches si lo soporta.

## Verificación
- `npx tsc --noEmit`, `npm run lint`, `npm test` (nuevo test incluido).
- Manual en RPi: texto→texto, voz→voz, override ambos sentidos.
