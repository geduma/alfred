/* Minimal WebSocket client with request/response correlation for the Alfred gateway. */
(function (global) {
  let ws = null;
  let idCounter = 1;
  const pending = new Map();
  const listeners = {};

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      setStatus(true);
      emit('open');
    };
    ws.onclose = () => {
      setStatus(false);
      emit('close');
      rejectAll('Connection closed');
      setTimeout(connect, 3000);
    };
    ws.onerror = () => { /* handled via close */ };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'res') {
        const handler = pending.get(msg.id);
        if (handler) {
          pending.delete(msg.id);
          if (msg.ok) handler.resolve(msg.payload);
          else handler.reject(new Error(msg.message || 'Request failed'));
        }
      } else if (msg.type === 'error') {
        const handler = pending.get(msg.id);
        if (handler) {
          pending.delete(msg.id);
          handler.reject(new Error(msg.message || 'Error'));
        } else {
          emit('error', msg.message || 'Error');
        }
      } else if (msg.type === 'event' || msg.type === 'notify') {
        emit(msg.event || 'event', msg.payload);
      }
    };
  }

  function request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to the gateway'));
        return;
      }
      const id = `req_${idCounter++}`;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Timeout'));
        }
      }, timeoutMs);
    });
  }

  // Fire-and-forget for methods answered via events (e.g. 'agent' → 'agent_complete').
  function send(method, params) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to the gateway'));
    }
    ws.send(JSON.stringify({ type: 'req', id: `req_${idCounter++}`, method, params }));
    return Promise.resolve();
  }

  function on(event, handler) {
    (listeners[event] = listeners[event] || []).push(handler);
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach((h) => h(payload));
  }

  function setStatus(online) {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (!dot || !label) return;
    dot.className = 'dot ' + (online ? 'online' : 'offline');
    label.textContent = online ? 'Connected' : 'Disconnected';
  }

  function rejectAll(message) {
    for (const { reject } of pending.values()) reject(new Error(message));
    pending.clear();
  }

  connect();
  global.AlfredWS = { request, send, on };
})(window);
