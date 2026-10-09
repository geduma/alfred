# Plan — 002 web-voice-mic-only

## Precondición (bloqueante)
Resolver HTTPS con certificado válido en la RPi de Alfred (PRD). Sin esto `window.isSecureContext === false` y `getUserMedia` no existe en iOS → no hay fix posible de solo-micrófono. Verificar en PRD: abrir la web por `https://` en iPhone → `window.isSecureContext === true` en consola.

## Archivos a tocar
1. `web/index.html` — quitar `capture` de `#audio-input`, ampliar `accept` a lista explícita de audios.
2. `web/js/audio-recorder.js` — eliminar `nativeMode` (fallback a cámara); en no-secure deshabilitar mic con mensaje HTTPS.
3. `web/js/file-uploader.js` — validar `audio/*` en handler de `audioInput`; rechazar `video/*` con error visible.
4. `tests/unit/web-voice-mic-only.test.ts` (nuevo, si hay harness DOM/jsdom) — o checklist manual si no.

## Diseño
- `index.html`:
  ```html
  <input type="file" id="audio-input" accept="audio/m4a,audio/mp4,audio/mpeg,audio/wav,audio/webm,audio/ogg" hidden>
  ```
- `audio-recorder.js`:
  - Borrar rama `else if (audioInput && isTouchDevice()) { nativeMode = true; ... }`.
  - Si `!isSecureContext || !navigator.mediaDevices || !window.MediaRecorder` ⇒ `disableMic('Microphone requires HTTPS (secure connection).')`.
  - Borrar variable `nativeMode` y rama `if (nativeMode) { audioInput.click(); }` del click handler. El botón solo llama a `start()` (que ya pide `getUserMedia({ audio: true })`).
  - `audioInput` puede quedar como referencia muerta o eliminarse del todo; si se elimina, quitar también su listener en `file-uploader.js`. Propuesta: eliminarlo del todo para que no haya path a cámara.
- `file-uploader.js` (si se conserva el input como selector de archivo):
  - En handler `[cameraInput, audioInput]`, distinguir: para `audioInput`, si `file.type && !file.type.startsWith('audio/')` ⇒ `sendError('Solo se permiten notas de voz (audio).')` y no llamar a `readFile`.
  - Alternativa limpia: sacar `audioInput` de ese array y darle handler propio con la validación.
- Sin cambios en gateway ni `agent_audio`/`agent_file`.

## Riesgos
- iOS < 14.3 no tiene `MediaRecorder`; el botón quedará deshabilitado con mensaje HTTPS. Aceptable: cuota residual mínima.
- Usuarios en `http://` local perderán el botón de mic hasta migrar a `https://`. Es el comportamiento correcto (antes grababa video por error).
- HEIC/mov: la validación por `file.type` en iOS a veces viene vacía; como segunda barrera validar por extensión (`.mov/.mp4/.avi` ⇒ rechazar en input de audio).

## Verificación
- `npx tsc --noEmit`, `npm run lint` (si aplica a `web/js`), `npm test`.
- Manual en RPi por HTTPS en iPhone: pulsar mic → pide solo micrófono → graba → llega `agent_audio` (no `agent_file`, no video). En HTTP: botón deshabilitado con aviso, nunca abre cámara.
