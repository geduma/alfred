(function () {
  const editor = document.getElementById('config-editor');
  const refreshBtn = document.getElementById('config-refresh');
  const saveBtn = document.getElementById('config-save');
  const reloadBtn = document.getElementById('config-reload');
  const status = document.getElementById('config-status');

  function showStatus(text, kind) {
    status.textContent = text;
    status.className = 'config-status ' + (kind || '');
  }

  async function loadConfig() {
    try {
      const res = await AlfredWS.request('config_get', {});
      editor.value = JSON.stringify(res.config, null, 2);
      showStatus('Configuration loaded. Secrets are masked.', 'ok');
    } catch (err) {
      showStatus('Error loading: ' + err.message, 'err');
    }
  }

  async function saveConfig() {
    let patch;
    try {
      patch = JSON.parse(editor.value);
    } catch (err) {
      showStatus('Invalid JSON: ' + err.message, 'err');
      return;
    }

    try {
      await AlfredWS.request('config_update', { config: patch });
      showStatus('Saved. Use "Apply (reload)" to apply the changes.', 'ok');
    } catch (err) {
      showStatus('Error saving: ' + err.message, 'err');
    }
  }

  async function reload() {
    try {
      await AlfredWS.request('reload', {});
      showStatus('Configuration reloaded and applied.', 'ok');
    } catch (err) {
      showStatus('Error reloading: ' + err.message, 'err');
    }
  }

  refreshBtn.addEventListener('click', loadConfig);
  saveBtn.addEventListener('click', saveConfig);
  reloadBtn.addEventListener('click', reload);

  loadConfig();
})();
