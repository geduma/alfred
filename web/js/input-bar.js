/* Input bar: textarea, send button states, char counter, record/send coordination. */
(function () {
  const bus = window.AlfredBus;
  const textarea = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');
  const statusText = document.getElementById('input-status-text');
  const charCount = document.getElementById('char-count');
  const micBtn = document.getElementById('btn-mic');
  const attachBtn = document.getElementById('btn-attach');
  const cameraBtn = document.getElementById('btn-camera');
  const MAX_CHARS = 3000;

  let sending = false;
  let offline = false;
  let recording = false;

  function autoResize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  function update() {
    const canSend = !sending && !offline && !recording && textarea.value.trim().length > 0;
    sendBtn.disabled = !canSend;
    sendBtn.classList.toggle('sending', sending);
    sendBtn.classList.toggle('error', false);
    charCount.textContent = textarea.value.length + '/' + MAX_CHARS;
    charCount.style.color = textarea.value.length > MAX_CHARS * 0.9 ? 'var(--warning)' : '';
    textarea.disabled = sending || recording || offline;
    micBtn.disabled = sending || offline;
    attachBtn.disabled = sending || offline;
    if (cameraBtn) cameraBtn.disabled = sending || offline;
  }

  function setState(kind, msg) {
    sending = kind === 'sending';
    sendBtn.classList.toggle('sending', kind === 'sending');
    sendBtn.classList.toggle('error', kind === 'error');
    sendBtn.title = kind === 'sending' ? 'Sending…' : '';
    statusText.textContent = msg || ('Status: ' + (kind === 'ready' ? 'Ready' : kind.charAt(0).toUpperCase() + kind.slice(1)));
    statusText.classList.toggle('rec-active', kind === 'rec');
    update();
  }

  function send() {
    if (sending || offline || recording) return;
    const text = textarea.value.trim();
    if (!text) return;

    setState('sending', 'Sending…');
    window.AlfredChat.appendUserText(text);
    textarea.value = '';
    autoResize();
    update();

    AlfredWS.send('agent', {
      message: text,
      sessionId: window.AlfredChat.SESSION_ID,
    }).catch((err) => {
      setState('error', 'Failed: ' + err.message);
      window.AlfredChat.appendError(err.message);
    });
  }

  textarea.addEventListener('input', () => { autoResize(); update(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  bus.on('agent-complete', () => {
    if (!offline) setState('ready');
  });

  bus.on('agent-error', () => {
    if (!sending) return;
    setState('error', 'Failed — check connection');
  });

  bus.on('rec', ({ state }) => {
    recording = state === 'start';
    if (recording) {
      setState('rec', 'REC — speaking…');
    } else {
      setState('ready');
    }
    update();
  });

  bus.on('conn', ({ online }) => {
    offline = !online;
    if (offline) {
      setState('ready', 'Disconnected');
      statusText.textContent = 'Status: Disconnected';
    } else {
      setState('ready');
    }
    update();
  });

  update();
})();
