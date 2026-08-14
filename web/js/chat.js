/* Chat renderer: text, audio, image/file attachments, streaming deltas, transcript + TTS playback. */
(function () {
  const messages = document.getElementById('messages');
  const bus = window.AlfredBus;
  const SESSION_ID = 'web-user';

  let pendingBubble = null;
  let pendingAudio = null;

  function fmtTime(d) {
    return (d || new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function iconFor(mime) {
    if (!mime) return '📄';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.startsWith('image/')) return '🖼️';
    if (mime === 'application/pdf') return '📕';
    if (mime.startsWith('text/')) return '📝';
    return '📄';
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function createMsg(kind) {
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = fmtTime();
    el.appendChild(meta);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = kind === 'user' ? 'YOU'
      : kind === 'agent' ? 'ALFRED'
      : kind === 'error' ? 'ALERT' : 'SYSTEM';
    el.appendChild(label);
    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    messages.appendChild(el);
    scrollBottom();
    return { el, body };
  }

  function setText(body, text) {
    body.textContent = text;
    body.classList.remove('streaming-cursor');
  }

  function attachAudio(body, url, mime) {
    const row = document.createElement('div');
    row.className = 'audio-row';
    const span = document.createElement('span');
    span.textContent = '🔊';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    row.appendChild(span);
    row.appendChild(audio);
    body.appendChild(row);
  }

  function appendUserText(text) {
    const { body } = createMsg('user');
    setText(body, text);
  }

  function appendUserAudio(durationMs) {
    const { el, body } = createMsg('user');
    const row = document.createElement('div');
    row.className = 'audio-row';
    const span = document.createElement('span');
    span.textContent = '🎙️';
    const info = document.createElement('span');
    info.textContent = 'audio message' + (durationMs ? ' · ' + (durationMs / 1000).toFixed(1) + 's' : '');
    row.appendChild(span);
    row.appendChild(info);
    body.appendChild(row);
    const tr = document.createElement('div');
    tr.className = 'transcript';
    tr.textContent = 'Transcribing…';
    body.appendChild(tr);
    el._transcriptEl = tr;
    return el;
  }

  function appendUserFile({ name, mime, size, dataUrl }) {
    const { body } = createMsg('user');
    const attach = document.createElement('div');
    attach.className = 'attach';
    if (mime && mime.startsWith('image/') && dataUrl) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = name || 'attachment';
      img.src = dataUrl;
      attach.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.style.fontSize = '22px';
      ic.textContent = iconFor(mime);
      attach.appendChild(ic);
    }
    const info = document.createElement('div');
    info.className = 'file-info';
    info.innerHTML = '<span class="fname">' + escapeHtml(name || 'file') + '</span>'
      + (size ? ' · ' + fmtBytes(size) : '');
    attach.appendChild(info);
    body.appendChild(attach);
  }

  function appendAgentText(text, extra) {
    const { body } = createMsg('agent');
    setText(body, text);
    if (extra && extra.audioUrl) attachAudio(body, extra.audioUrl, extra.mime);
  }

  function appendNotify(message) {
    const { body } = createMsg('notify');
    setText(body, message);
  }

  function appendError(message) {
    const { body } = createMsg('error');
    setText(body, message);
    bus.emit('agent-error');
  }

  /* ── Streaming ── */
  function beginStream(runId) {
    if (pendingBubble) {
      setText(pendingBubble.body, pendingBubble.buffer || '');
    }
    pendingBubble = { el: null, body: null, runId, buffer: '' };
  }

  function appendDelta(runId, text) {
    if (!pendingBubble || pendingBubble.runId !== runId) beginStream(runId);
    pendingBubble.buffer += text;
    if (!pendingBubble.body) {
      const created = createMsg('agent');
      pendingBubble.el = created.el;
      pendingBubble.body = created.body;
    }
    pendingBubble.body.textContent = pendingBubble.buffer;
    pendingBubble.body.classList.add('streaming-cursor');
    scrollBottom();
  }

  function finalizeStream(runId, finalText, extra) {
    let target = null;
    if (pendingBubble && pendingBubble.runId === runId) {
      target = pendingBubble;
      pendingBubble = null;
    }
    if (target) {
      setText(target.body, finalText);
      if (extra && extra.audioUrl) attachAudio(target.body, extra.audioUrl, extra.mime);
      if (extra && extra.error) {
        target.el.classList.remove('agent');
        target.el.classList.add('error');
        const label = target.el.querySelector('.label');
        if (label) label.textContent = 'ALERT';
      }
    } else {
      appendAgentText(finalText, extra);
    }
    bus.emit('agent-complete');
  }

  /* ── WS events ── */
  AlfredWS.on('agent_delta', (payload) => {
    if (payload && typeof payload.text === 'string') appendDelta(payload.runId, payload.text);
  });

  AlfredWS.on('agent_complete', (payload) => {
    if (!payload) return;
    const extra = {};
    if (payload.error) extra.error = true;
    if (pendingAudio) {
      extra.audioUrl = pendingAudio.url;
      extra.mime = pendingAudio.mime;
      pendingAudio = null;
    }
    finalizeStream(payload.runId, payload.content || '', extra);
  });

  AlfredWS.on('agent_audio', (payload) => {
    if (!payload || !payload.base64) return;
    const mime = payload.mime || 'audio/wav';
    const binary = atob(payload.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    if (pendingAudio) URL.revokeObjectURL(pendingAudio.url);
    pendingAudio = { url: URL.createObjectURL(blob), mime };
  });

  AlfredWS.on('transcript', (payload) => {
    if (!payload || !payload.text) return;
    const users = messages.querySelectorAll('.msg.user');
    const last = users[users.length - 1];
    if (last && last._transcriptEl) {
      last._transcriptEl.textContent = '🎙️ "' + payload.text + '"';
      scrollBottom();
    }
  });

  AlfredWS.on('message', (payload) => {
    if (payload && payload.message) appendNotify(payload.message);
  });

  AlfredWS.on('error', (message) => {
    appendError(message);
  });

  window.AlfredChat = {
    appendUserText,
    appendUserAudio,
    appendUserFile,
    appendError,
    SESSION_ID,
  };
})();
