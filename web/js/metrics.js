/* Left panel: real-time telemetry cards (status, tokens, providers, skills, health, workspace). */
(function () {
  const grid = document.getElementById('metrics-grid');
  const statusEl = document.getElementById('metrics-status');
  const bus = window.AlfredBus;
  const REFRESH_MS = 5000;
  const STALE_MS = 15000;
  let timer = null;
  let lastOkAt = 0;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'metrics-status ' + (kind || '');
  }

  const ICONS = {
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    'bar-chart': '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  };

  function icon(name) {
    return '<svg class="card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  function card(title, iconName, nodes) {
    const el = document.createElement('div');
    el.className = 'card';
    const h = document.createElement('h3');
    h.innerHTML = icon(iconName) + '<span>' + title + '</span>';
    el.appendChild(h);
    nodes.forEach((node) => el.appendChild(node));
    return el;
  }

  function check() {
    return '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  }

  function value(html, cls) {
    const el = document.createElement('div');
    el.className = 'value' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
    return el;
  }

  function sub(text) {
    const el = document.createElement('div');
    el.className = 'sub';
    el.textContent = text;
    return el;
  }

  function row(k, v) {
    const el = document.createElement('div');
    el.className = 'row';
    const kEl = document.createElement('span');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.className = 'v';
    vEl.textContent = v;
    el.appendChild(kEl);
    el.appendChild(vEl);
    return el;
  }

  function badge(text, cls) {
    const el = document.createElement('span');
    el.className = 'badge ' + (cls || 'muted');
    el.textContent = text;
    return el;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const s = Math.floor(sec);
    if (s < 60) return s + 's';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = s % 60;
    const parts = [];
    if (d > 0) parts.push(d + 'd');
    if (h > 0 || d > 0) parts.push(h + 'h');
    if (m > 0 || h > 0 || d > 0) parts.push(m + 'm');
    if (d === 0 && h === 0) parts.push(rest + 's');
    return parts.join(' ');
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtLatency(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
  }

  function fmtSize(mb, bytes) {
    if (typeof bytes === 'number' && Number.isFinite(bytes)) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    }
    const v = Number(mb) || 0;
    if (v <= 0) return '0 KB';
    if (v < 0.1) return Math.max(1, Math.round(v * 1024)) + ' KB';
    if (v < 10) return v.toFixed(1) + ' MB';
    return Math.round(v) + ' MB';
  }

  function budgetBarClass(pct) {
    if (pct >= 80) return 'err';
    if (pct >= 50) return 'warn';
    return 'ok';
  }

  function statusCard(m) {
    const online = (m.webClients || 0) > 0;
    const nodes = [
      value(check() + 'Ready'),
      sub(online ? m.webClients + ' client(s) online' : 'Gateway reachable'),
      row('Uptime', fmtTime(m.uptimeSec)),
      row('Model', m.activeModel || '—'),
      row('Latency', fmtLatency(m.latencyMs ?? m.avgLatencyMs)),
    ];
    if (m.latencyMs == null && m.avgLatencyMs == null) {
      nodes.push(sub('Latency appears after the first query.'));
    }
    return card('Alfred Status', 'activity', nodes);
  }

  function budgetCard(m) {
    const b = m.budget || {};
    const enabled = b.enabled !== false;
    const pct = Math.round(b.remainingPercent ?? 100);
    const used = Math.round(100 - pct);
    const allowed = b.allowed !== false;

    const fill = document.createElement('div');
    fill.className = 'bar-fill ' + budgetBarClass(used);
    fill.style.width = Math.min(100, Math.max(0, used)) + '%';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuenow', String(used));
    bar.appendChild(fill);

    const nodes = [
      value(pct + '%', allowed ? '' : 'err'),
      sub(enabled ? 'Budget remaining' : 'Usage tracked · no limits set'),
      bar,
      row('Used today', fmtNum(b.today) + ' tok'),
      row('Used month', fmtNum(b.thisMonth) + ' tok'),
    ];
    if (enabled) {
      nodes.push(row('Daily limit', fmtNum(b.dailyLimit || 0) + ' tok'));
      if (b.monthlyLimit) nodes.push(row('Monthly limit', fmtNum(b.monthlyLimit) + ' tok'));
    }
    const byProvider = b.byProvider || {};
    Object.keys(byProvider).forEach((name) => {
      nodes.push(row(name, fmtNum(byProvider[name].tokens) + ' tok'));
    });
    nodes.push(allowed ? badge('OK', 'ok') : badge('BLOCKED', 'err'));
    return card('Tokens', 'bar-chart', nodes);
  }

  function providerCard(m) {
    const nodes = [];
    const states = m.providers?.states || [];
    if (states.length === 0) nodes.push(sub('No provider state'));
    states.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'provider-item';
      const name = document.createElement('div');
      name.className = 'p-name';
      const tag = document.createElement('span');
      tag.className = 'tag';
      if (s.open) {
        tag.textContent = 'BLOCKED';
        tag.style.color = 'var(--danger)';
      } else if (s.remainingMs > 0) {
        tag.textContent = 'HALF-OPEN';
        tag.style.color = 'var(--warning)';
      } else {
        tag.textContent = 'HEALTHY';
        tag.style.color = 'var(--success)';
      }
      name.textContent = s.provider;
      name.appendChild(tag);
      const subEl = document.createElement('div');
      subEl.className = 'p-sub';
      subEl.textContent = s.open
        ? 'Retry: ' + Math.ceil(s.remainingMs / 1000) + 's'
        : (s.failures > 0 ? s.failures + ' recent failure(s)' : 'Operational');
      item.appendChild(name);
      item.appendChild(subEl);
      nodes.push(item);
    });
    const chain = m.providers?.chain || [];
    if (chain.length > 0) {
      nodes.push(row('Primary', chain[0]));
      if (chain.length > 1) nodes.push(row('Fallbacks', chain.slice(1).join(', ')));
    }
    return card('Providers', 'link', nodes);
  }

  function skillsCard(m) {
    const skills = m.skills || 0;
    const nodes = [row('Loaded', String(skills))];
    const wrap = document.createElement('div');
    wrap.className = 'skill-chips';
    const names = m.skillNames || [];
    if (names.length > 0) {
      names.forEach((n) => {
        const chip = document.createElement('span');
        chip.className = 'skill-chip';
        chip.textContent = n;
        wrap.appendChild(chip);
      });
      nodes.push(wrap);
    } else {
      nodes.push(sub('No skills loaded.'));
    }
    return card('Skills', 'tool', nodes);
  }

  function healthCard(m) {
    const h = m.health || {};
    const errors = h.errors || 0;
    const total = h.findings || 0;
    const nodes = [
      value(fmtNum(total), errors > 0 ? 'err' : ''),
      sub(errors > 0 ? errors + ' error(s) need attention' : (total > 0 ? 'Recent findings' : 'No findings')),
    ];
    (h.items || []).slice(0, 4).forEach((f) => {
      const sev = f.severity === 'error' ? 'err' : 'warn';
      const line = row(f.category || 'finding', String(f.count) + '×');
      const b = badge(f.severity || 'warn', sev);
      line.appendChild(b);
      nodes.push(line);
    });
    nodes.push(errors > 0 ? badge(errors + ' error(s)', 'err') : (total > 0 ? badge('review', 'warn') : badge('clear', 'ok')));
    return card('Health', 'heart', nodes);
  }

  function workspaceCard(m) {
    const w = m.workspace || {};
    const nodes = [
      row('Audio files', fmtSize(w.filesSizeMb, w.filesSizeBytes)),
      row('DB size', fmtSize(w.dbSizeMb, w.dbSizeBytes)),
      row('Active sessions', fmtNum(w.sessionsTotal)),
      row('Web clients', fmtNum(m.webClients)),
    ];
    return card('Workspace', 'folder', nodes);
  }

  function render(m) {
    grid.innerHTML = '';
    const cards = [
      statusCard(m),
      budgetCard(m),
      providerCard(m),
      skillsCard(m),
      healthCard(m),
      workspaceCard(m),
    ];
    cards.forEach((c) => grid.appendChild(c));
    bus.emit('metrics', m);
  }

  async function refresh() {
    try {
      const res = await AlfredWS.request('metrics', {});
      const m = res.metrics || {};
      render(m);
      lastOkAt = Date.now();
      const t = m.serverTime ? new Date(m.serverTime) : new Date();
      const label = isNaN(t.getTime()) ? new Date().toLocaleTimeString() : t.toLocaleTimeString();
      setStatus('● LIVE · ' + label, 'ok');
    } catch (err) {
      const ago = lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) : null;
      if (String(err.message || '').toLowerCase().includes('not connected')) {
        setStatus(ago ? 'Waiting for connection… · last data ' + ago + 's ago' : 'Waiting for connection…', 'stale');
      } else {
        // Keep last rendered cards; only mark stale.
        const stale = lastOkAt && (Date.now() - lastOkAt > STALE_MS);
        setStatus('Metrics unavailable: ' + err.message, stale ? 'stale' : 'err');
      }
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
  }

  AlfredWS.on('open', start);
  start();
})();
