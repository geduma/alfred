/* Right panel: last query, RAG/session state, jobs, and editable preferences. */
(function () {
  const grid = document.getElementById('context-grid');
  const bus = window.AlfredBus;

  function card(title, nodes) {
    const el = document.createElement('div');
    el.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title;
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
    return card('🔍 Last Query', nodes);
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
    return card('🧠 RAG Memory', nodes);
  }

  function sessionCard() {
    const nodes = [];
    nodes.push(row('Snapshots', snapshots.enabled ? 'Enabled' : 'Disabled', snapshots.enabled ? badge('ON', 'ok') : badge('OFF', 'muted')));
    nodes.push(empty('Session compression is managed automatically by Alfred.'));
    return card('📦 Session', nodes);
  }

  function jobsCard() {
    const nodes = [
      row('Jobs', fmtNum(jobs.enabled) + ' / ' + fmtNum(jobs.total)),
      row('Next due', jobs.nextDue ? fmtDateTime(jobs.nextDue) : '—'),
    ];
    return card('📋 Jobs', nodes);
  }

  /* ── Preferences (built once) ── */
  const PREF_FIELDS = [
    { key: 'language', label: 'Language', options: ['english', 'spanish', 'auto'] },
    { key: 'tone', label: 'Tone', options: ['professional', 'casual', 'friendly'] },
    { key: 'formality', label: 'Formality', options: ['formal', 'informal'] },
    { key: 'verbosity', label: 'Verbosity', options: ['concise', 'normal', 'detailed'] },
    { key: 'voice_replies', label: 'Voice replies', options: ['never', 'always', 'on_request'] },
  ];

  let prefs = {};
  let prefCardEl = null;
  let prefSelects = {};
  let prefToast = null;

  function buildPreferencesCard() {
    const nodes = PREF_FIELDS.map((f) => {
      const wrap = document.createElement('div');
      wrap.className = 'select-row';
      const label = document.createElement('span');
      label.textContent = f.label;
      const select = document.createElement('select');
      f.options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        select.appendChild(o);
      });
      select.addEventListener('change', () => setPreference(f.key, select.value));
      wrap.appendChild(label);
      wrap.appendChild(select);
      prefSelects[f.key] = select;
      return wrap;
    });

    prefToast = document.createElement('div');
    prefToast.className = 'pref-toast';
    nodes.push(prefToast);
    return card('⚙️ Preferences', nodes);
  }

  function applyPrefs() {
    PREF_FIELDS.forEach((f) => {
      const select = prefSelects[f.key];
      if (!select) return;
      const current = prefs[f.key];
      if (current && Array.from(select.options).every((o) => o.value !== current)) {
        const o = document.createElement('option');
        o.value = current;
        o.textContent = current;
        select.appendChild(o);
      }
      select.value = current && Array.from(select.options).some((o) => o.value === current)
        ? current
        : f.options[0];
    });
  }

  async function setPreference(key, value) {
    try {
      await AlfredWS.request('preference_set', { key, value });
      prefs[key] = value;
      if (prefToast) {
        prefToast.textContent = '✓ ' + key + ' updated';
        setTimeout(() => { if (prefToast) prefToast.textContent = ''; }, 2000);
      }
    } catch (err) {
      if (prefToast) prefToast.textContent = '✗ ' + (err.message || 'failed');
    }
  }

  async function loadPreferences() {
    try {
      const res = await AlfredWS.request('preferences', {});
      prefs = (res.preferences || {});
      applyPrefs();
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
    applyPrefs();
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
