(function () {
  const grid = document.getElementById('metrics-grid');
  const status = document.getElementById('metrics-status');
  const REFRESH_MS = 5000;
  let timer = null;

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'metrics-status ' + (kind || '');
  }

  function card(title, content) {
    const el = document.createElement('div');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    content.forEach((node) => el.appendChild(node));
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

  function row(k, v, badge) {
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
    if (badge) el.appendChild(badge);
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

  function budgetCards(m) {
    const b = m.budget || {};
    const pct = Math.round(b.remainingPercent || 0);
    const allowed = b.allowed !== false;
    const statusBadge = allowed ? badge('OK', 'ok') : badge('BLOCKED', 'err');

    const nodes = [
      value(pct + '%', allowed ? '' : 'err'),
      sub('Budget remaining'),
      row('Today', fmtNum(b.today)),
      row('Month', fmtNum(b.thisMonth)),
      row('Daily left', fmtNum(b.dailyLimit ? b.dailyLimit - (b.today || 0) : null)),
      row('Monthly left', fmtNum(b.monthlyLimit ? b.monthlyLimit - (b.thisMonth || 0) : null)),
    ];

    const byProvider = b.byProvider || {};
    const providers = Object.keys(byProvider);
    if (providers.length > 0) {
      providers.forEach((name) => {
        nodes.push(row(name, fmtNum(byProvider[name].tokens) + ' tok'));
      });
    }
    nodes.push(statusBadge);
    return card('Token budget', nodes);
  }

  function providerCards(m) {
    const nodes = [];
    const states = m.providers?.states || [];
    if (states.length === 0) {
      nodes.push(sub('No provider state'));
    }
    states.forEach((s) => {
      const open = s.open;
      const badgeEl = open
        ? badge('OPEN', 'err')
        : (s.remainingMs > 0 ? badge('half-open', 'warn') : badge('ok', 'ok'));
      nodes.push(row(s.provider, open ? 'blocked' : 'healthy', badgeEl));
    });
    const chain = m.providers?.chain || [];
    if (chain.length > 0) {
      nodes.push(row('Primary', chain[0]));
      if (chain.length > 1) nodes.push(row('Fallback', chain.slice(1).join(', ')));
    }
    return card('Providers', nodes);
  }

  function systemCards(m) {
    return card('System', [
      row('Version', m.version || '—'),
      row('Uptime', fmtTime(m.uptimeSec)),
      row('Web clients', fmtNum(m.webClients)),
      row('Tools', fmtNum(m.tools)),
    ]);
  }

  function sessionCards(m) {
    return card('Sessions', [
      value(fmtNum(m.sessions?.active), ''),
      sub('Active in memory'),
      row('Jobs', fmtNum(m.jobs?.enabled) + ' / ' + fmtNum(m.jobs?.total)),
      row('Skills', fmtNum(m.skills)),
    ]);
  }

  function jobCards(m) {
    const j = m.jobs || {};
    const next = j.nextDue ? new Date(j.nextDue).toLocaleString() : '—';
    return card('Jobs', [
      value(fmtNum(j.enabled) + ' / ' + fmtNum(j.total), ''),
      sub('Enabled / total'),
      row('Next due', next),
    ]);
  }

  function healthCards(m) {
    const h = m.health || {};
    const errors = h.errors || 0;
    const total = h.findings || 0;
    const badgeEl = errors > 0 ? badge(errors + ' error(s)', 'err') : (total > 0 ? badge('warn', 'warn') : badge('clear', 'ok'));
    const nodes = [
      value(fmtNum(total), errors > 0 ? 'err' : ''),
      sub('Recent findings'),
    ];
    (h.items || []).slice(0, 4).forEach((f) => {
      nodes.push(row(f.category, f.count + 'x', badge(f.severity, f.severity === 'error' ? 'err' : 'warn')));
    });
    nodes.push(badgeEl);
    return card('Health', nodes);
  }

  function render(m) {
    grid.innerHTML = '';
    const cards = [
      systemCards(m),
      budgetCards(m),
      providerCards(m),
      sessionCards(m),
      jobCards(m),
      healthCards(m),
    ];
    cards.forEach((c) => grid.appendChild(c));
  }

  async function refresh() {
    try {
      const res = await AlfredWS.request('metrics', {});
      render(res.metrics || {});
      setStatus('Updated ' + new Date().toLocaleTimeString() + ' — auto-refresh every ' + (REFRESH_MS / 1000) + 's', 'ok');
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('not connected')) {
        setStatus('Waiting for connection…', 'stale');
      } else {
        setStatus('Metrics unavailable: ' + err.message, 'err');
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
