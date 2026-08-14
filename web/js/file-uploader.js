/* File uploader: pick files or capture from camera, then send via agent_file. */
(function () {
  const attachBtn = document.getElementById('btn-attach');
  const fileInput = document.getElementById('file-input');
  const cameraBtn = document.getElementById('btn-camera');
  const attachments = document.getElementById('attachments');
  const MAX_SIZE = 50 * 1024 * 1024;

  function sendError(msg) {
    window.AlfredChat.appendError(msg);
  }

  function showChip(file, dataUrl) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    chip.dataset.id = file.name + '_' + Date.now();
    if (file.type && file.type.startsWith('image/') && dataUrl) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = dataUrl;
      chip.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.textContent = '📄';
      chip.appendChild(ic);
    }
    const info = document.createElement('span');
    info.textContent = file.name;
    chip.appendChild(info);
    const remove = document.createElement('span');
    remove.className = 'a-remove';
    remove.textContent = '✕';
    remove.title = 'Remove';
    chip.appendChild(remove);
    remove.addEventListener('click', () => chip.remove());
    attachments.appendChild(chip);
    return chip;
  }

  async function sendFile(file, dataUrl) {
    const chip = showChip(file, dataUrl);
    window.AlfredChat.appendUserFile({
      name: file.name,
      mime: file.type,
      size: file.size,
      dataUrl,
    });
    try {
      await AlfredWS.send('agent_file', {
        blob_base64: String(dataUrl).split(',')[1] || '',
        name: file.name,
        mime: file.type || 'application/octet-stream',
        sessionId: window.AlfredChat.SESSION_ID,
      });
    } catch (err) {
      sendError(err.message);
    } finally {
      setTimeout(() => chip.remove(), 400);
    }
  }

  function readFile(file) {
    if (file.size > MAX_SIZE) {
      sendError('File too large: ' + file.name + ' (max 50 MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => sendFile(file, reader.result);
    reader.onerror = () => sendError('Could not read file: ' + file.name);
    reader.readAsDataURL(file);
  }

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    files.forEach(readFile);
  });

  /* ── Camera (mobile only) ── */
  function captureFromCamera() {
    let stream = null;
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.85);display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;gap:16px;';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = 'max-width:90vw;max-height:60vh;border:1px solid var(--border-strong);border-radius:10px;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px;';

    const captureBtn = document.createElement('button');
    captureBtn.className = 'send-btn';
    captureBtn.style.cssText = 'width:auto;padding:0 20px;';
    captureBtn.textContent = '📷 Capture';
    captureBtn.addEventListener('click', async () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      const file = { name: 'camera.jpg', type: 'image/jpeg', size: Math.round(dataUrl.length * 0.75) };
      sendFile(file, dataUrl);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'manage-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
    });

    actions.appendChild(captureBtn);
    actions.appendChild(cancelBtn);
    overlay.appendChild(video);
    overlay.appendChild(actions);
    document.body.appendChild(overlay);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s;
        video.srcObject = s;
        video.play().catch(() => {});
      })
      .catch(() => {
        overlay.remove();
        sendError('Camera access denied.');
      });
  }

  if (cameraBtn) {
    cameraBtn.addEventListener('click', captureFromCamera);
  }
})();
