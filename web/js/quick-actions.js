/* Quick actions: deterministic server actions (no LLM). Doctor is the first. */
(function () {
  const barId = 'quick-actions';
  const sideId = 'quick-actions-side';
  let running = false;

  function el(id) { return document.getElementById(id); }

  function setRunning(v) {
    running = v;
    document.querySelectorAll('[data-quick-action]').forEach((b) => {
      b.disabled = v;
    });
  }

  function statusFor(res) {
    if (res.status === 'ok') return '✅ ok';
    if (res.status === 'warnings') return '⚠️ warnings';
    if (res.status === 'failures') return '❌ failures';
    return 'exit ' + (res.exitCode == null ? '?' : res.exitCode);
  }

  async function run(action, label) {
    if (running) return;
    if (!window.AlfredWS || !window.AlfredWS.isConnected()) {
      if (window.AlfredChat) window.AlfredChat.appendError('Not connected to the gateway');
      return;
    }
    setRunning(true);
    try {
      if (window.AlfredChat) window.AlfredChat.appendUserText('🩺 Ejecutando ' + label + '…');
      const res = await window.AlfredWS.request('quick_action', {
        action,
        sessionId: (window.AlfredChat && window.AlfredChat.SESSION_ID) || 'web-user',
      }, 65000);
      const meta = statusFor(res)
        + (res.durationMs != null ? ' · ' + (res.durationMs / 1000).toFixed(1) + 's' : '')
        + (res.truncated ? ' · truncado' : '');
      if (window.AlfredChat) {
        window.AlfredChat.appendQuickActionResult(label + ' — ' + statusFor(res), res.output || '(sin salida)', meta);
      }
    } catch (err) {
      if (window.AlfredChat) window.AlfredChat.appendError('Quick action failed: ' + (err.message || err));
    } finally {
      setRunning(false);
    }
  }

  function chip(def) {
    const b = document.createElement('button');
    b.className = 'qa-chip';
    b.type = 'button';
    b.dataset.quickAction = def.id;
    b.setAttribute('aria-label', 'Ejecutar ' + def.label + (def.hint ? ' — ' + def.hint : ''));
    b.title = def.hint || def.label;
    b.textContent = (def.icon ? def.icon + ' ' : '') + def.label;
    b.addEventListener('click', () => run(def.id, def.label));
    return b;
  }

  function renderInto(container, actions) {
    if (!container) return;
    container.innerHTML = '';
    if (!actions.length) {
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');
    actions.forEach((a) => container.appendChild(chip(a)));
  }

  async function load() {
    let actions = [{ id: 'doctor', label: 'Doctor', icon: '🩺', hint: 'Diagnóstico read-only' }];
    try {
      const res = await window.AlfredWS.request('quick_actions_list', {}, 15000);
      if (res && Array.isArray(res.actions) && res.actions.length) actions = res.actions;
    } catch {
      // offline or old server: keep fallback Doctor chip
    }
    renderInto(el(barId), actions);
    renderInto(el(sideId), actions);
  }

  function start() { load(); }
  if (window.AlfredWS) {
    window.AlfredWS.on('open', start);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
  window.AlfredQuickActions = { run, load };
})();
