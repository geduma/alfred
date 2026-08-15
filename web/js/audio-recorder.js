/* Microphone recorder: MediaRecorder → base64 → agent_audio. */
(function () {
  const bus = window.AlfredBus;
  const btn = document.getElementById('btn-mic');
  const recIndicator = document.getElementById('rec-indicator');
  const recTimer = document.getElementById('rec-timer');

  let recorder = null;
  let chunks = [];
  let stream = null;
  let startTime = 0;
  let timerInterval = null;
  let cancelled = false;

  function audioSupport() {
    return {
      secure: !!window.isSecureContext,
      mediaDevices: !!(window.isSecureContext && navigator.mediaDevices),
      recorder: !!window.MediaRecorder,
    };
  }

  function disableMic(reason) {
    btn.disabled = true;
    btn.title = reason;
    btn.setAttribute('aria-label', reason);
  }

  const support = audioSupport();
  if (!support.secure || !support.mediaDevices) {
    disableMic('Microphone requires HTTPS (secure connection).');
  } else if (!support.recorder) {
    disableMic('Audio recording is not supported in this browser.');
  }

  function pickMime() {
    if (!window.MediaRecorder) return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', ''];
    for (const c of candidates) {
      if (!c || MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function buildWaveform() {
    const existing = recIndicator.querySelector('.waveform');
    if (existing) existing.remove();
    const wave = document.createElement('div');
    wave.className = 'waveform';
    for (let i = 0; i < 14; i++) {
      const bar = document.createElement('span');
      bar.style.animationDelay = (i * 0.08) + 's';
      wave.appendChild(bar);
    }
    recIndicator.insertBefore(wave, recTimer);
  }

  function updateTimer() {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60);
    recTimer.textContent = m + ':' + String(s % 60).padStart(2, '0');
  }

  async function start() {
    if (!window.isSecureContext) {
      window.AlfredChat.appendError('Microphone requires HTTPS (secure connection).');
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      window.AlfredChat.appendError('Audio recording is not supported in this browser.');
      return;
    }
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      window.AlfredChat.appendError('Microphone access denied.');
      return;
    }

    stream = micStream;
    chunks = [];
    cancelled = false;
    const mime = pickMime();
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      if (!cancelled && chunks.length) sendAudio();
      cleanup();
    };
    recorder.onerror = () => stop(true);
    recorder.start();

    startTime = Date.now();
    btn.classList.add('recording');
    recIndicator.classList.remove('hidden');
    buildWaveform();
    updateTimer();
    timerInterval = setInterval(updateTimer, 100);
    bus.emit('rec', { state: 'start' });
  }

  function stop(cancel) {
    if (!recorder) return;
    cancelled = cancel;
    clearInterval(timerInterval);
    timerInterval = null;
    btn.classList.remove('recording');
    try { recorder.stop(); } catch { /* already stopped */ }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); }
  }

  function cleanup() {
    stream = null;
    recorder = null;
    recIndicator.classList.add('hidden');
    bus.emit('rec', { state: 'stop' });
  }

  function sendAudio() {
    const blob = new Blob(chunks, { type: recorder ? recorder.mimeType : 'audio/webm' });
    const durationMs = Date.now() - startTime;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] || '';
      if (!base64) return;
      window.AlfredChat.appendUserAudio(durationMs);
      AlfredWS.send('agent_audio', {
        blob_base64: base64,
        mime: blob.type || 'audio/webm',
        duration_ms: durationMs,
        sessionId: window.AlfredChat.SESSION_ID,
      }).catch((err) => window.AlfredChat.appendError(err.message));
    };
    reader.onerror = () => window.AlfredChat.appendError('Could not read the recording.');
    reader.readAsDataURL(blob);
  }

  btn.addEventListener('click', () => {
    if (recorder) stop(false);
    else start();
  });

  bus.on('conn', ({ online }) => {
    if (!online && recorder) stop(true);
  });
})();
