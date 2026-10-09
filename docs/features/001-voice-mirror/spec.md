# Spec — 001 voice-mirror (mirror de modalidad por defecto)

## Status
Draft — pendiente de aprobación

## Context
Hoy Alfred en Telegram solo responde con audio si el LLM emite el marcador `[AUDIO]` al final (`shouldSynthesizeVoice`). Por defecto todo es texto, aunque el usuario haya enviado nota de voz. Además el audio se envía con `sendAudio` (reproductor de música, requiere abrir y no se siente automático).

El usuario pide: audio → audio, texto → texto, por defecto. Solo cambiar si en la interacción se pide lo contrario. Y que el audio en Telegram se reproduzca automáticamente (burbuja de voz inline).

## Non-goals
- No cambiar STT ni proveedor de voz (Speaches sigue igual).
- No tocar web/CLI: el mirror solo aplica a Telegram. Web mantiene marcador `[AUDIO]` actual.
- No transcodificación: se sigue enviando el buffer que devuelve TTS (wav), solo cambia el método de envío.
- No autoplay real sin gesto: Telegram no permite reproducir sin que el usuario pulse al menos una vez por privacidad. "Automático" = burbuja de voz inline (sendVoice) con un tap, no reproductor externo.

## User stories + Acceptance
1. **US1 — audio→audio por defecto.** Envío nota de voz sin pedir nada especial → recibo burbuja de voz (sendVoice) + caption con el texto. Aceptación: `input_type=voice`, sin petición de texto y sin marcador `[TEXT]` ⇒ `synthesize=true` y se llama a `sendVoice`.
2. **US2 — texto→texto por defecto.** Envío texto sin pedir audio → recibo solo texto. Aceptación: `input_type=text`, sin petición de audio y sin marcador `[AUDIO]` ⇒ `synthesize=false`, no se llama a TTS.
3. **US3 — override explícito en la interacción.** En audio digo "respóndeme solo por texto / escríbelo / sin audio" → recibo solo texto. En texto digo "mándamelo en audio / respóndeme por voz" → recibo voz. Aceptación: regex ES/EN detecta la petición y prevalece sobre el default. Marcadores `[AUDIO]` / `[TEXT]` al final del LLM también prevalecen y se limpian del texto visible.
4. **US4 — reproducción automática.** El audio llega como nota de voz (burbuja, waveform, inline), no como archivo de música. Aceptación: el código usa `bot.api.sendVoice(chatId, InputFile(buffer,'alfred.ogg'), {caption})` con action `upload_voice`; fallback a texto si TTS falla.
5. **US5 — degradación.** Si TTS falla, recibo el texto igual. Aceptación: catch loguea y llama a `sendMessage` con el texto limpio.

## Open questions
1. ¿El caption debe llevar el texto completo (hasta 1024 chars) o prefieres sin caption para que parezca nota de voz pura? Propuesta: con caption truncado (actual).
2. ¿Quieres que el override por texto del usuario quede también persistido como preferencia (`voice_replies`)? Propuesta: no, solo por interacción.
