# Tasks — 001 voice-mirror

- [ ] T1 — `telegram.ts`: extender `shouldSynthesizeVoice` a `resolveVoiceReply(response, inputType, userText)` con reglas + regex + limpieza `[AUDIO]`/`[TEXT]`.
- [ ] T2 — `telegram.ts`: cambiar envío a `sendVoice` (+ `upload_voice` action) con fallback a texto.
- [ ] T3 — `voice-notes.skill.md`: reescribir sección de protocolo (mirror por defecto + overrides).
- [ ] T4 — `tests/unit/telegram-voice-mirror.test.ts`: casos US1–US3 + limpieza de marcadores + sin servicio.
- [ ] T5 — Gates: `npx tsc --noEmit` + `npm run lint` + `npm test`.
- [ ] T6 — Verificación manual en RPi (texto→texto, voz→voz, overrides ambos sentidos).
