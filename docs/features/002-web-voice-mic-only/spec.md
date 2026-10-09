# Spec — 002 web-voice-mic-only (solo micrófono para notas de voz en web/iOS)

## Status
Blocked — pendiente de HTTPS en PRD (RPi de Alfred). No implementar hasta resolver certificado SSL.

## Context
En channel web, el botón de enviar audio en iOS abre la cámara y envía un video en lugar de una nota de voz.

Causa raíz verificada (Oct 2026):
- `web/index.html:83`: `<input type="file" id="audio-input" accept="audio/*" capture hidden>` — el atributo `capture` en iOS Safari no tiene grabadora de solo-audio; resuelve a app de Cámara (video `.mov`).
- `web/js/audio-recorder.js:32-43`: si `!window.isSecureContext` (HTTP, caso actual de PRD sin HTTPS) y es táctil, entra en `nativeMode = true`.
- `web/js/audio-recorder.js:158-159`: en `nativeMode` el click del mic hace `audioInput.click()` → abre cámara.
- `web/js/file-uploader.js:88-99`: ese video vuelve por el flujo `agent_file` como si fuera nota de voz.

El único path que pide solo micrófono es `getUserMedia({ audio: true }) + MediaRecorder` (`audio-recorder.js:start()`), que exige secure context (HTTPS). En PRD hoy es HTTP, por eso siempre cae al fallback roto.

## Non-goals
- No montar HTTPS / certificado en este issue (se resuelve aparte en la RPi).
- No cambiar STT ni backend de `agent_audio` / `agent_file`.
- No transcodificación en frontend.
- No tocar flujo de cámara de fotos (`camera-input` / `btn-camera`) — solo el de audio.
- No pedir autoplay ni cambios en reproducción TTS.

## User stories + Acceptance
1. **US1 — nota de voz pide solo micrófono en iOS.** Pulso mic en iPhone por HTTPS → el navegador pide permiso de micrófono (no cámara) y graba audio. Aceptación: `getUserMedia({ audio: true })` sin `video`, envío por `agent_audio` con `mime audio/*`.
2. **US2 — sin `capture` no abre cámara.** El input fallback ya no lleva `capture`. Aceptación: inspeccionar `web/index.html` — `#audio-input` sin atributo `capture`; en iOS por HTTP abre selector de archivos, nunca cámara directa.
3. **US3 — el fallback rechaza video.** Si igual llega un `.mov` / `video/*` al input de audio, se rechaza con mensaje. Aceptación: archivo `video/*` en `audioInput` ⇒ error visible "Solo se permiten notas de voz (audio)" y no se envía por `agent_file`.
4. **US4 — en HTTP el botón explica en vez de engañar.** Sin secure context, el mic queda deshabilitado o avisa "Microphone requires HTTPS". Aceptación: en `http://` el botón no abre cámara; muestra el aviso.

## Open questions
1. ¿En HTTP deshabilitamos el mic por completo o lo dejamos como selector de archivos de audio existentes? Propuesta: deshabilitar con tooltip HTTPS (más claro que el fallback actual).
2. ¿El `accept` del fallback queda como lista explícita `audio/m4a,audio/mp4,audio/mpeg,audio/wav,audio/webm,audio/ogg` en vez de `audio/*` genérico? Propuesta: sí, mejor compatibilidad iOS (m4a/mp4).
