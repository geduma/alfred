(function () {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const messages = document.getElementById('messages');
  const sendButton = form.querySelector('button');

  function append(kind, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = new Date().toLocaleTimeString();
    const body = document.createElement('div');
    body.textContent = text;
    el.appendChild(meta);
    el.appendChild(body);
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function markTyping() {
    sendButton.disabled = true;
    sendButton.textContent = 'Sending...';
  }

  function clearTyping() {
    sendButton.disabled = false;
    sendButton.textContent = 'Send';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    append('user', text);
    markTyping();

    try {
      await AlfredWS.send('agent', { message: text, sessionId: 'web-user' });
    } catch (err) {
      append('error', err.message);
      clearTyping();
    } finally {
      input.focus();
    }
  });

  AlfredWS.on('agent_complete', (payload) => {
    clearTyping();
    if (!payload) return;
    if (payload.content) {
      append(payload.degraded ? 'error' : 'agent', payload.content);
    }
  });

  AlfredWS.on('error', (message) => {
    clearTyping();
    append('error', message);
  });

  AlfredWS.on('message', (payload) => {
    if (payload && payload.message) {
      append('notify', payload.message);
    }
  });
})();
