/* Layout shell: global event bus, connection banner, mobile panel tabs, header stats, sidebar toggles. */
(function () {
  const bus = {
    handlers: {},
    on(event, handler) {
      (this.handlers[event] = this.handlers[event] || []).push(handler);
      return () => {
        const arr = this.handlers[event] || [];
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(event, payload) {
      (this.handlers[event] || []).forEach((h) => { try { h(payload); } catch (e) { /* ignore */ } });
    },
  };
  window.AlfredBus = bus;

  const banner = document.getElementById('conn-banner');
  const mobileTabs = document.querySelectorAll('.mtab');
  const panels = {
    left: document.getElementById('panel-left'),
    center: document.getElementById('panel-center'),
    right: document.getElementById('panel-right'),
  };

  function setConn(online) {
    banner.classList.toggle('hidden', online);
    bus.emit('conn', { online });
  }

  function switchMobile(name) {
    mobileTabs.forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
    Object.keys(panels).forEach((k) => {
      const el = panels[k];
      if (!el) return;
      if (k === name) {
        el.classList.add('mobile-open');
        el.style.display = '';
      } else if (k === 'center') {
        el.classList.remove('mobile-open');
      } else {
        el.classList.remove('mobile-open');
      }
    });
  }

  mobileTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchMobile(tab.dataset.panel));
  });

  /* ── Sidebar toggles (desktop) ── */
  const toggleLeft = document.getElementById('toggle-left');
  const toggleRight = document.getElementById('toggle-right');
  function applyToggle(btn, cls, hide) {
    document.body.classList.toggle(cls, hide);
    if (btn) btn.setAttribute('aria-pressed', String(!hide));
    try { localStorage.setItem('alfred:' + cls, hide ? '1' : '0'); } catch { /* ignore */ }
  }
  function restoreToggle(btn, cls) {
    let hide = false;
    try { hide = localStorage.getItem('alfred:' + cls) === '1'; } catch { /* ignore */ }
    // Only apply on desktop widths; mobile uses tabs.
    if (window.matchMedia && window.matchMedia('(max-width: 1100px)').matches) hide = false;
    applyToggle(btn, cls, hide);
  }
  if (toggleLeft) {
    toggleLeft.addEventListener('click', () =>
      applyToggle(toggleLeft, 'hide-left', !document.body.classList.contains('hide-left')));
    restoreToggle(toggleLeft, 'hide-left');
  }
  if (toggleRight) {
    toggleRight.addEventListener('click', () =>
      applyToggle(toggleRight, 'hide-right', !document.body.classList.contains('hide-right')));
    restoreToggle(toggleRight, 'hide-right');
  }

  function fmtUptime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const s = Math.floor(sec);
    if (s < 60) return s + 's';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = s % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + rest + 's';
  }

  function fmtLatency(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  }

  const hdrModel = document.getElementById('hdr-model-v');
  const hdrLatency = document.getElementById('hdr-latency-v');
  const hdrUptime = document.getElementById('hdr-uptime-v');

  let lastUptimeSec = null;
  bus.on('metrics', (m) => {
    if (!m) return;
    if (hdrModel) hdrModel.textContent = m.activeModel || '—';
    if (hdrLatency) hdrLatency.textContent = fmtLatency(m.latencyMs ?? m.avgLatencyMs);
    if (typeof m.uptimeSec === 'number') {
      lastUptimeSec = m.uptimeSec;
      if (hdrUptime) hdrUptime.textContent = fmtUptime(m.uptimeSec);
    }
  });

  // Local 1s tick so uptime visibly advances between 5s polls.
  let tickBase = null;
  let tickStartedAt = 0;
  setInterval(() => {
    if (lastUptimeSec === null || !hdrUptime) return;
    if (tickBase !== lastUptimeSec) {
      tickBase = lastUptimeSec;
      tickStartedAt = Date.now();
    }
    const elapsed = Math.floor((Date.now() - tickStartedAt) / 1000);
    hdrUptime.textContent = fmtUptime(tickBase + elapsed);
  }, 1000);

  AlfredWS.on('open', () => setConn(true));
  AlfredWS.on('close', () => setConn(false));
})();
