/* Right panel: last query, RAG/session state, jobs, and read-only preferences. */
(function () {
  const grid = document.getElementById('context-grid');
  const bus = window.AlfredBus;

  const ICONS = {
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
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

  function empty(text) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = text;
    return el;
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtLatency(ms) {
    if (!Number.isFinite(ms)) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  let lastQuery = null;
  let jobs = { total: 0, enabled: 0, nextDue: null };
  let rag = { enabled: false };
  let snapshots = { enabled: false };

  function lastQueryCard() {
    const nodes = [];
    if (!lastQuery) {
      nodes.push(empty('No queries yet'));
    } else {
      if (lastQuery.content) {
        const snippet = lastQuery.content.length > 60 ? lastQuery.content.slice(0, 60) + '…' : lastQuery.content;
        nodes.push(empty('"' + snippet + '"'));
      }
      nodes.push(row('Input', fmtNum(lastQuery.input_tokens) + ' tok'));
      nodes.push(row('Output', fmtNum(lastQuery.output_tokens) + ' tok'));
      nodes.push(row('Model', lastQuery.model || '—'));
      nodes.push(row('Latency', fmtLatency(lastQuery.latency_ms)));
      nodes.push(row('At', fmtDateTime(lastQuery.at)));
    }
    return card('Last Query', 'search', nodes);
  }

  function ragCard() {
    const nodes = [];
    if (!rag.enabled) {
      nodes.push(badge('DISABLED', 'muted'));
      nodes.push(empty('Long-term memory retrieval is not enabled.'));
    } else {
      nodes.push(badge('ACTIVE', 'ok'));
      nodes.push(empty('Memory retrieval enabled.'));
    }
    return card('RAG Memory', 'database', nodes);
  }

  function sessionCard() {
    const nodes = [];
    nodes.push(row('Snapshots', snapshots.enabled ? 'Enabled' : 'Disabled', snapshots.enabled ? badge('ON', 'ok') : badge('OFF', 'muted')));
    nodes.push(empty('Session compression is managed automatically by Alfred.'));
    return card('Session', 'layers', nodes);
  }

  function jobsCard() {
    const nodes = [
      row('Jobs', fmtNum(jobs.enabled) + ' / ' + fmtNum(jobs.total)),
      row('Next due', jobs.nextDue ? fmtDateTime(jobs.nextDue) : '—'),
    ];
    return card('Jobs', 'clock', nodes);
  }

  /* ── Preferences (read-only, built once) ── */
  const PREF_FIELDS = [
    { key: 'language', label: 'Language', default: 'auto' },
    { key: 'tone', label: 'Tone', default: 'professional' },
    { key: 'formality', label: 'Formality', default: 'formal' },
    { key: 'verbosity', label: 'Verbosity', default: 'normal' },
    { key: 'voice_replies', label: 'Voice replies', default: 'never' },
  ];

  let prefs = {};
  let prefCardEl = null;
  let prefValues = {};

  function buildPreferencesCard() {
    const nodes = PREF_FIELDS.map((f) => {
      const el = row(f.label, '—');
      prefValues[f.key] = el.querySelector('.v');
      return el;
    });
    nodes.push(empty('Preferences are managed in preferences.md.'));
    return card('Preferences', 'sliders', nodes);
  }

  function applyPrefValues() {
    PREF_FIELDS.forEach((f) => {
      const el = prefValues[f.key];
      if (!el) return;
      const current = prefs[f.key];
      el.innerHTML = '';
      const value = document.createElement('span');
      value.textContent = current || f.default;
      el.appendChild(value);
      if (!current) {
        const hint = document.createElement('span');
        hint.className = 'default-hint';
        hint.textContent = '(default)';
        el.appendChild(hint);
      }
    });
  }

  async function loadPreferences() {
    try {
      const res = await AlfredWS.request('preferences', {});
      prefs = (res.preferences || {});
      applyPrefValues();
    } catch {
      // preferences unavailable
    }
  }

  function render() {
    grid.innerHTML = '';
    [lastQueryCard(), ragCard(), sessionCard(), jobsCard()].forEach((c) => grid.appendChild(c));
    if (!prefCardEl) {
      prefCardEl = buildPreferencesCard();
    }
    applyPrefValues();
    grid.appendChild(prefCardEl);
  }

  bus.on('metrics', (m) => {
    if (!m) return;
    if (m.lastQuery) lastQuery = m.lastQuery;
    if (m.jobs) jobs = m.jobs;
    if (m.rag) rag = m.rag;
    if (m.snapshots) snapshots = m.snapshots;
    render();
  });

  AlfredWS.on('open', loadPreferences);
  render();
  loadPreferences();
})();
