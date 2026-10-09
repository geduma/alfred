# Tasks — 002 web-voice-mic-only

> Bloqueado hasta HTTPS en PRD (RPi). No ejecutar antes.

- [ ] T0 — Precondición infra: certificado SSL válido en RPi; verificar `window.isSecureContext === true` en iPhone por `https://`.
- [ ] T1 — `web/index.html`: quitar `capture` de `#audio-input` (o eliminar el input); dejar `accept` explícito de audio.
- [ ] T2 — `web/js/audio-recorder.js`: eliminar `nativeMode` y rama táctil-HTTP; deshabilitar mic sin secure context con mensaje HTTPS.
- [ ] T3 — `web/js/file-uploader.js`: validar `audio/*` en input de audio; rechazar `video/*` (por MIME + extensión `.mov/.mp4`) con error visible.
- [ ] T4 — Tests/checklist: `npx tsc --noEmit` + `npm run lint` + `npm test`; manual iPhone HTTPS (solo-mic, `agent_audio`) + HTTP (no abre cámara).
- [ ] T5 — Verificación en RPi PRD y cierre del issue.
