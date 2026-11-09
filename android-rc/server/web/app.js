function normalizeXY(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return { nx: Math.max(0, Math.min(1, x)), ny: Math.max(0, Math.min(1, y)) };
}

function sendTouch(action, pointerId, clientX, clientY) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { nx, ny } = normalizeXY(clientX, clientY);
  const msg = { t: 'touch', action, nx, ny, pointerId };
  ws.send(JSON.stringify(msg));
  log(`touch ${action} (${nx.toFixed(2)},${ny.toFixed(2)})`);
}

canvas.addEventListener('pointerdown', (e) => { sendTouch('down', e.pointerId, e.clientX, e.clientY); });
canvas.addEventListener('pointermove', (e) => { if (e.buttons > 0) sendTouch('move', e.pointerId, e.clientX, e.clientY); });
canvas.addEventListener('pointerup', (e) => { sendTouch('up', e.pointerId, e.clientX, e.clientY); });
canvas.addEventListener('pointercancel', (e) => { sendTouch('up', e.pointerId, e.clientX, e.clientY); });
canvas.addEventListener('pointerleave', (e) => { if (e.buttons === 0) sendTouch('up', e.pointerId, e.clientX, e.clientY); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const { nx, ny } = normalizeXY(e.clientX, e.clientY);
  const msg = { t: 'scroll', nx, ny, dy: -Math.sign(e.deltaY) * 10 };
  ws.send(JSON.stringify(msg));
  log(`scroll dy=${msg.dy}`, 'viewer');
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const msg = { t: 'key', k: e.key };
  ws.send(JSON.stringify(msg));
  log(`key: ${e.key}`, 'viewer');
});

const textInput = document.createElement('input');
textInput.type = 'text';
textInput.placeholder = 'Type to send text to device…';
textInput.style.cssText = 'position:absolute; bottom:150px; left:50%; transform:translateX(-50%); z-index:50;';
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && ws && ws.readyState === WebSocket.OPEN) {
    const msg = { t: 'text', v: textInput.value };
    ws.send(JSON.stringify(msg));
    log(`text: ${textInput.value}`, 'viewer');
    textInput.value = '';
  }
});
document.body.appendChild(textInput);

loadDevices();
setInterval(loadDevices, 10000);
log('RC Viewer ready');
function connectDevice(deviceId) {
  if (ws) { ws.close(); ws = null; }
  currentDeviceId = deviceId;
  setStatus('Connecting…');
  log(`Opening session for ${deviceId}`);

  fetch(`${API_BASE}/api/devices/${deviceId}/session`, { method: 'POST' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      currentSessionId = data.sessionId;
      currentToken = data.token;
      log(`Session ${data.sessionId} created`);
      openRelay(data.wsUrl);
    })
    .catch((e) => {
      log(`Session error: ${e.message}`, 'error');
      setStatus('Error');
      currentDeviceId = null;
    });
}

function openRelay(wsUrl) {
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('Connected', 'online');
    log('Relay WS open');
    ws.send(JSON.stringify({ t: 'hello' }));
    ws.send(JSON.stringify({ t: 'viewer.join' }));
    log('Sent: hello, viewer.join');
    updateUI(true);
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try { handleJson(JSON.parse(ev.data)); } catch { log(`Unknown text: ${ev.data.slice(0,100)}`); }
      return;
    }
    const frame = parseFrame(ev.data);
    if (!frame) return;
    if (frame.type === TYPE_JPEG) {
      drawJpeg(frame.payload);
      log(`JPEG ${frame.payload.byteLength} bytes`, 'dev');
    } else if (frame.type === TYPE_CONFIG) {
      log('0x01 config (cached)', 'dev');
    } else if (frame.type === TYPE_KEY) {
      log('0x02 key frame (cached)', 'dev');
    } else if (frame.type === TYPE_DELTA) {
      log('0x03 delta (JPEG-only mode)', 'dev');
    }
  };

  ws.onclose = () => {
    setStatus('Disconnected');
    log('Relay WS closed');
    ws = null;
    updateUI(false);
    noSignal.style.display = 'block';
  };

  ws.onerror = () => {
    log('WS error', 'error');
    setStatus('Error');
  };
}

function handleJson(msg) {
  if (msg.t === 'hello') log('Server: hello');
  else if (msg.t === 'viewer.join') log('Joined as viewer');
  else if (msg.t === 'log') log(`Device: ${msg.msg || ''}`, 'dev');
  else log(JSON.stringify(msg).slice(0, 200));
}

function updateUI(connected) {
  document.querySelectorAll('.device-card button').forEach((b) => {
    const id = b.dataset.id;
    if (connected && id === currentDeviceId) {
      b.textContent = 'Disconnect';
      b.className = 'btn connected danger';
      b.onclick = (e) => { e.stopPropagation(); disconnect(); };
    } else {
      const online = b.closest('.device-card').classList.contains('online');
      b.textContent = online ? 'Connect' : 'Offline';
      b.className = online ? '' : ':disabled';
      b.onclick = (e) => { e.stopPropagation(); if (online) connectDevice(id); };
    }
  });
  logPane.classList.toggle('visible', connected);
  h264Notice.style.display = connected ? 'block' : 'none';
}

function disconnect() {
  if (!currentDeviceId || !currentSessionId) return;
  fetch(`${API_BASE}/api/devices/${currentDeviceId}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: 'session.stop' })
  }).then(() => log('Sent: session.stop')).catch((e) => log(`Stop error: ${e.message}`, 'error'));
  if (ws) { ws.close(); ws = null; }
  updateUI(false);
  noSignal.style.display = 'block';
  currentDeviceId = null; currentSessionId = null; currentToken = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function renderDevices(devices) {
  if (!devices || devices.length === 0) {
    deviceListEl.innerHTML = '<div style="color:#66fcf1; font-size:12px;">No devices online</div>';
    return;
  }
  deviceListEl.innerHTML = '';
  for (const d of devices) {
    const card = document.createElement('div');
    card.className = `device-card ${d.online ? 'online' : 'offline'}`;
    const dot = d.online ? '<span class="dot online"></span>' : '<span class="dot offline"></span>';
    const lastSeen = d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : 'never';
    const caps = d.caps && d.caps.h264 ? 'H264' : 'JPEG';
    card.innerHTML = `
      <div class="device-title">${dot}<strong>${escapeHtml(d.id)}</strong></div>
      <div class="device-meta"><span>v${d.version || '?'}</span><span>${caps}</span><span>${lastSeen}</span></div>
      <button class="btn ${d.online ? '' : ':disabled'}" data-id="${d.id}">${d.online ? 'Connect' : 'Offline'}</button>
    `;
    const btn = card.querySelector('button');
    btn.onclick = (e) => { e.stopPropagation(); if (d.online) connectDevice(d.id); };
    deviceListEl.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" })[c]);
}

function fitCanvasToVideo(videoW, videoH) {
  const wrap = canvas.parentElement;
  const wrapW = wrap.clientWidth || 640;
  const wrapH = wrap.clientHeight || 400;
  const scale = Math.min(wrapW / videoW, wrapH / videoH);
  canvas.width = videoW;
  canvas.height = videoH;
  canvas.style.width = (videoW * scale) + 'px';
  canvas.style.height = (videoH * scale) + 'px';
}

function drawJpeg(arrayBuffer) {
  createImageBitmap(new Blob([arrayBuffer])).then((bitmap) => {
    fitCanvasToVideo(bitmap.width, bitmap.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    noSignal.style.display = 'none';
  }).catch((e) => {
    log(`JPEG decode error: ${e.message}`, 'error');
  });
}

function parseFrame(data) {
  if (data.byteLength < FRAME_HEADER_SIZE) return null;
  const dv = new DataView(data);
  const type = dv.getUint8(0);
  const pts = dv.getBigUInt64BE(1);
  const payload = data.slice(FRAME_HEADER_SIZE);
  return { type, pts: Number(pts), payload };
}
const API_BASE = (() => {
  const h = window.location.hostname;
  const p = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
  return `http://${h}:${p === '80' || p === '443' ? 8090 : p}`;
})();

const FRAME_HEADER_SIZE = 9;
const TYPE_CONFIG = 0x01;
const TYPE_KEY = 0x02;
const TYPE_DELTA = 0x03;
const TYPE_JPEG = 0x04;

let ws = null;
let currentDeviceId = null;
let currentSessionId = null;
let currentToken = null;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const noSignal = document.getElementById('noSignal');
const deviceListEl = document.getElementById('deviceList');
const statusEl = document.getElementById('status');
const logPane = document.getElementById('logPane');
const logContent = document.getElementById('logContent');
const h264Notice = document.getElementById('h264Notice');

function log(msg, cls = 'viewer') {
  const div = document.createElement('div');
  div.className = `log-entry ${cls}`;
  const t = new Date().toISOString().split('T')[1].slice(0, 12);
  div.textContent = `[${t}] ${msg}`;
  logContent.appendChild(div);
  logContent.scrollTop = logContent.scrollHeight;
}

function setStatus(txt, cls = '') {
  statusEl.textContent = txt;
  statusEl.className = cls;
}

async function loadDevices() {
  try {
    const res = await fetch(`${API_BASE}/api/devices`);
    const data = await res.json();
    renderDevices(data.devices || []);
  } catch (e) {
    log(`Failed to load devices: ${e.message}`, 'error');
    deviceListEl.innerHTML = '<div style="color:#ff6b6b;">Cannot reach API</div>';
  }
}