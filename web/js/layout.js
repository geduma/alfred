/* Layout shell: global event bus, connection banner, mobile panel tabs, header stats. */
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

  let activeMobile = 'center';

  function setConn(online) {
    banner.classList.toggle('hidden', online);
    bus.emit('conn', { online });
  }

  function switchMobile(name) {
    activeMobile = name;
    mobileTabs.forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
    Object.keys(panels).forEach((k) => {
      const el = panels[k];
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

  function fmtUptime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function fmtLatency(ms) {
    if (!Number.isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  }

  const hdrModel = document.getElementById('hdr-model-v');
  const hdrLatency = document.getElementById('hdr-latency-v');
  const hdrUptime = document.getElementById('hdr-uptime-v');

  bus.on('metrics', (m) => {
    if (!m) return;
    if (hdrModel) hdrModel.textContent = m.activeModel || '—';
    if (hdrLatency) hdrLatency.textContent = fmtLatency(m.latencyMs ?? m.avgLatencyMs);
    if (hdrUptime) hdrUptime.textContent = fmtUptime(m.uptimeSec);
  });

  AlfredWS.on('open', () => setConn(true));
  AlfredWS.on('close', () => setConn(false));
})();
