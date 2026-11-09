import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const PORT = Number(process.env.RELAY_PORT || 8081);
const HOST = process.env.RELAY_HOST || '0.0.0.0';
const TOKEN_SECRET = process.env.TOKEN_SECRET;

function verifyToken(token) {
  try {
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx <= 0) return null;
    const payload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [sessionId, deviceId, expiresAt] = payload.split('|');
    if (!sessionId || !deviceId || !expiresAt) return null;
    if (Date.now() > Date.parse(expiresAt)) return null;
    return { sessionId, deviceId, expiresAt };
  } catch {
    return null;
  }
}

const FRAME_HEADER_SIZE = 9;
function parseHeader(buf) {
  if (buf.length < FRAME_HEADER_SIZE) return null;
  const type = buf.readUInt8(0);
  const pts = buf.readBigUInt64BE(1);
  return { type, pts: Number(pts) };
}

function packHeader(type, pts) {
  const buf = Buffer.alloc(FRAME_HEADER_SIZE);
  buf.writeUInt8(type, 0);
  buf.writeBigUInt64BE(BigInt(pts), 1);
  return buf;
}

const TYPE_CONFIG = 0x01;
const TYPE_KEY = 0x02;
const TYPE_DELTA = 0x03;
const TYPE_JPEG = 0x04;

const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      device: null,
      viewer: null,
      cache: { config: null, key: null, jpeg: null },
      viewerBackpressure: false,
    });
  }
  return sessions.get(sessionId);
}

function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.device) { try { s.device.close(); } catch {} s.device = null; }
  if (s.viewer) { try { s.viewer.close(); } catch {} s.viewer = null; }
  sessions.delete(sessionId);
  console.log(`[RELAY] session closed: ${sessionId}`);
}

function forwardToPeer(ws, sessionId, role, data, isBinary) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const peer = role === 'device' ? s.viewer : s.device;
  if (!peer || peer.readyState !== WebSocket.OPEN) return;
  if (role === 'device' && isBinary && data.length >= FRAME_HEADER_SIZE) {
    const hdr = parseHeader(data);
    if (hdr && hdr.type === TYPE_DELTA && s.viewerBackpressure) {
      return;
    }
  }
  peer.send(data, { binary: isBinary }, (err) => {
    if (err) console.error(`[RELAY] send error to ${role}:`, err.message);
  });
}

function replayCacheToViewer(ws, sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.cache) return;
  const { config, key, jpeg } = s.cache;
  if (config) ws.send(config, { binary: true });
  if (key) ws.send(key, { binary: true });
  if (jpeg) ws.send(jpeg, { binary: true });
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname !== '/relay') {
    ws.close(1008, 'wrong path');
    return;
  }

  const role = url.searchParams.get('role');
  const sessionId = url.searchParams.get('session');
  const token = url.searchParams.get('token');

  if (!role || !sessionId || !token) {
    ws.close(1008, 'missing params');
    return;
  }

  if (role !== 'device' && role !== 'viewer') {
    ws.close(1008, 'invalid role');
    return;
  }

  const parsed = verifyToken(token);
  if (!parsed || parsed.sessionId !== sessionId) {
    console.log(`[RELAY] reject: invalid token for session ${sessionId} role ${role}`);
    ws.close(1008, 'invalid token');
    return;
  }

  const s = getSession(sessionId);

  const existing = role === 'device' ? s.device : s.viewer;
  if (existing && existing.readyState === WebSocket.OPEN) {
    console.log(`[RELAY] reject: ${role} already connected for session ${sessionId}`);
    ws.close(1008, 'role already connected');
    return;
  }

  if (role === 'device') s.device = ws;
  else s.viewer = ws;

  console.log(`[RELAY] ${role} connected: session=${sessionId} device=${parsed.deviceId}`);

  if (role === 'viewer') {
    replayCacheToViewer(ws, sessionId);
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (data.length >= FRAME_HEADER_SIZE) {
        const hdr = parseHeader(data);
        if (hdr) {
          if (hdr.type === TYPE_CONFIG) s.cache.config = data;
          else if (hdr.type === TYPE_KEY) s.cache.key = data;
          else if (hdr.type === TYPE_JPEG) s.cache.jpeg = data;
        }
      }
      forwardToPeer(ws, sessionId, role, data, true);
    } else {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (role === 'viewer' && msg && msg.t === 'backpressure') {
        s.viewerBackpressure = !!msg.backpressure;
      }
      forwardToPeer(ws, sessionId, role, data, false);
    }
  });

  ws.on('close', () => {
    console.log(`[RELAY] ${role} disconnected: session=${sessionId}`);
    if (role === 'device') s.device = null;
    else s.viewer = null;
    const other = role === 'device' ? s.viewer : s.device;
    if (other) { try { other.close(); } catch {} }
    if (role === 'viewer') s.viewerBackpressure = false;
    if (!s.device && !s.viewer) {
      s.cache = { config: null, key: null, jpeg: null };
      setTimeout(() => {
        const s2 = sessions.get(sessionId);
        if (s2 && !s2.device && !s2.viewer) {
          sessions.delete(sessionId);
          console.log(`[RELAY] session removed: ${sessionId}`);
        }
      }, 30000);
    }
  });

  ws.on('error', (err) => {
    console.error(`[RELAY] ${role} error:`, err.message);
  });
});

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('rc-relay ok\n');
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Only start listening when run directly (not when imported by tests)
const IS_MAIN_RELAY = process.argv[1] && process.argv[1].endsWith('relay/index.mjs');
if (IS_MAIN_RELAY) {
  if (!TOKEN_SECRET || TOKEN_SECRET === 'CHANGE_ME_TOKEN_SECRET_HEX') {
    console.error('[FATAL] TOKEN_SECRET not set');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[RELAY] listening on ${HOST}:${PORT}`);
  });
}

export { verifyToken, parseHeader, packHeader, TYPE_CONFIG, TYPE_KEY, TYPE_DELTA, TYPE_JPEG, FRAME_HEADER_SIZE, getSession, sessions, closeSession };