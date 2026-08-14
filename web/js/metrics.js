/* Left panel: real-time telemetry cards (status, tokens, providers, skills, health, workspace). */
(function () {
  const grid = document.getElementById('metrics-grid');
  const statusEl = document.getElementById('metrics-status');
  const bus = window.AlfredBus;
  const REFRESH_MS = 5000;
  let timer = null;
  let lastOk = false;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'metrics-status ' + (kind || '');
  }

  function card(title, nodes) {
    const el = document.createElement('div');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    nodes.forEach((node) => el.appendChild(node));
    return el;
  }

  function value(text, cls) {
    const el = document.createElement('div');
    el.className = 'value' + (cls ? ' ' + cls : '');
    el.textContent = text;
    return el;
  }

  function sub(text) {
    const el = document.createElement('div');
    el.className = 'sub';
    el.textContent = text;
    return el;
  }

  function row(k, v, badgeEl) {
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
    if (badgeEl) el.appendChild(badgeEl);
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
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const parts = [];
    if (d > 0) parts.push(d + 'd');
    if (h > 0 || d > 0) parts.push(h + 'h');
    if (m > 0 || h > 0 || d > 0) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtLatency(ms) {
    if (!Number.isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  }

  function budgetBarClass(pct) {
    if (pct >= 80) return 'err';
    if (pct >= 50) return 'warn';
    return 'ok';
  }

  function statusCard(m) {
    const nodes = [
      value('✓ Ready', m.webClients > 0 ? '' : ''),
      sub(m.webClients > 0 ? m.webClients + ' client(s) online' : 'No web clients connected'),
      row('Uptime', fmtTime(m.uptimeSec)),
      row('Model', m.activeModel || '—'),
      row('Latency', fmtLatency(m.latencyMs ?? m.avgLatencyMs)),
    ];
    return card('● Alfred Status', nodes);
  }

  function budgetCard(m) {
    const b = m.budget || {};
    const pct = Math.round(b.remainingPercent ?? 100);
    const used = Math.round(100 - pct);
    const allowed = b.allowed !== false;

    const fill = document.createElement('div');
    fill.className = 'bar-fill ' + budgetBarClass(used);
    fill.style.width = Math.min(100, Math.max(0, used)) + '%';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.appendChild(fill);

    const nodes = [
      value(pct + '%', allowed ? '' : 'err'),
      sub('Budget remaining'),
      bar,
      row('Used today', fmtNum(b.today) + ' tok'),
      row('Used month', fmtNum(b.thisMonth) + ' tok'),
      row('Daily limit', fmtNum(b.dailyLimit || 0) + ' tok'),
    ];
    const byProvider = b.byProvider || {};
    Object.keys(byProvider).forEach((name) => {
      nodes.push(row(name, fmtNum(byProvider[name].tokens) + ' tok'));
    });
    nodes.push(allowed ? badge('OK', 'ok') : badge('BLOCKED', 'err'));
    return card('📊 Tokens', nodes);
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
    return card('🔗 Providers', nodes);
  }

  function skillsCard(m) {
    const skills = m.skills || 0;
    const nodes = [row('Loaded', skills)];
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
    }
    return card('⚙️ Skills', nodes);
  }

  function healthCard(m) {
    const h = m.health || {};
    const errors = h.errors || 0;
    const total = h.findings || 0;
    const nodes = [
      value(fmtNum(total), errors > 0 ? 'err' : ''),
      sub(errors > 0 ? errors + ' error(s)' : 'Recent findings'),
    ];
    (h.items || []).slice(0, 4).forEach((f) => {
      nodes.push(row(f.category || 'finding', f.count + 'x', badge(f.severity || 'warn', f.severity === 'error' ? 'err' : 'warn')));
    });
    nodes.push(errors > 0 ? badge(errors + ' error(s)', 'err') : (total > 0 ? badge('warn', 'warn') : badge('clear', 'ok')));
    return card('🏥 Health', nodes);
  }

  function workspaceCard(m) {
    const w = m.workspace || {};
    const nodes = [
      row('Audio files', (w.filesSizeMb || 0) + ' MB'),
      row('DB size', (w.dbSizeMb || 0) + ' MB'),
      row('Sessions', fmtNum(w.sessionsTotal)),
      row('Web clients', fmtNum(m.webClients)),
    ];
    return card('📁 Workspace', nodes);
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
      render(res.metrics || {});
      lastOk = true;
      setStatus('● LIVE · ' + new Date().toLocaleTimeString(), 'ok');
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('not connected')) {
        setStatus('Waiting for connection…', 'stale');
        lastOk = false;
      } else {
        setStatus('Metrics unavailable: ' + err.message, 'err');
        lastOk = false;
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
