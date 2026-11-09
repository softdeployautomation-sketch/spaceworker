import express from 'express';
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

const app = express();
app.use(express.json());

const PORT = Number(process.env.API_PORT || 8090);
const HOST = process.env.API_HOST || '127.0.0.1';
const RC_ENROLL_CODE = process.env.RC_ENROLL_CODE;
const INTERNAL_MQTT_USER = process.env.INTERNAL_MQTT_USER || 'rc-api';
const INTERNAL_MQTT_PASSWORD = process.env.INTERNAL_MQTT_PASSWORD || 'internal';
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const DB_PATH = process.env.DB_PATH || './data/devices.sqlite';
const WS_URL_PUBLIC = process.env.WS_URL_PUBLIC || 'wss://android.spaceworker.top/relay';
const MQTT_HOST = process.env.MQTT_HOST || 'mosquitto';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);

let SQL;
let db;
async function initDb() {
  SQL = await initSqlJs();
  const fs = await import('node:fs');
  let buf;
  try {
    buf = fs.readFileSync(DB_PATH);
  } catch {
    buf = null;
  }
  db = new SQL.Database(buf ? new Uint8Array(buf) : undefined);
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      online INTEGER DEFAULT 0,
      last_seen TEXT,
      caps TEXT,
      version TEXT,
      state_payload TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      closed INTEGER DEFAULT 0
    );
  `);
}

function saveDb() {
  try {
    const data = db.export();
    const parts = DB_PATH.split('/');
    parts.pop();
    const dir = parts.join('/');
    if (dir) {
      import('node:fs').then((fs) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DB_PATH, Buffer.from(data));
      }).catch((e) => {
        console.error('[WARN] failed to persist DB:', e.message);
      });
    } else {
      import('node:fs').then((fs) => {
        fs.writeFileSync(DB_PATH, Buffer.from(data));
      }).catch((e) => {
        console.error('[WARN] failed to persist DB:', e.message);
      });
    }
  } catch (e) {
    console.error('[WARN] failed to persist DB:', e.message);
  }
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function upsertDevice(deviceId, payload) {
  const now = new Date().toISOString();
  let online = 1, lastSeen = now, caps = null, version = null, statePayload = null;
  try {
    const parsed = JSON.parse(payload);
    online = parsed.online !== false ? 1 : 0;
    caps = parsed.caps ? JSON.stringify(parsed.caps) : null;
    version = parsed.version || null;
    lastSeen = parsed.lastSeen || now;
    statePayload = payload;
  } catch {
    // not JSON — still mark online
  }
  const safeId = sqlEscape(deviceId);
  const safePayload = sqlEscape(statePayload);
  const check = db.exec(`SELECT device_id FROM devices WHERE device_id = '${safeId}'`);
  const exists = check && check.length > 0 && check[0].values && check[0].values.length > 0;
  if (exists) {
    db.exec(`UPDATE devices SET online=${online}, last_seen='${sqlEscape(lastSeen)}', caps=${caps ? "'" + sqlEscape(caps) + "'" : 'NULL'}, version=${version ? "'" + sqlEscape(version) + "'" : 'NULL'}, state_payload='${safePayload}', updated_at='${sqlEscape(now)}' WHERE device_id='${safeId}'`);
  } else {
    db.exec(`INSERT INTO devices (device_id, online, last_seen, caps, version, state_payload, updated_at) VALUES ('${safeId}', ${online}, '${sqlEscape(now)}', ${caps ? "'" + sqlEscape(caps) + "'" : 'NULL'}, ${version ? "'" + sqlEscape(version) + "'" : 'NULL'}, '${safePayload}', '${sqlEscape(now)}')`);
  }
  saveDb();
}

function listDevices() {
  const result = db.exec('SELECT device_id, online, last_seen, caps, version FROM devices ORDER BY last_seen DESC');
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((r) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = r[i]; });
    return {
      id: obj.device_id,
      online: obj.online === 1,
      lastSeen: obj.last_seen,
      caps: obj.caps ? JSON.parse(obj.caps) : null,
      version: obj.version
    };
  });
}

function makeToken(sessionId, deviceId) {
  const secret = process.env.TOKEN_SECRET;
  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;
  const expiresAt = new Date(now + ttlMs).toISOString();
  const payload = `${sessionId}|${deviceId}|${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, expiresAt };
}

function verifyToken(token) {
  try {
    const secret = process.env.TOKEN_SECRET;
    // Split on the last '.' because the ISO-8601 expiresAt inside the payload
    // can itself contain a '.' (decimal seconds), e.g. 2026-11-09T11:48:05.654Z
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx <= 0) return null;
    const payload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [sessionId, deviceId, expiresAt] = payload.split('|');
    if (!sessionId || !deviceId || !expiresAt) return null;
    if (Date.now() > Date.parse(expiresAt)) return null;
    return { sessionId, deviceId, expiresAt };
  } catch {
    return null;
  }
}

let mqttClient;
let mqttConnected = false;
const stateTopicBase = 'rc/state/';
const eventTopicBase = 'rc/event/';
const cmdTopicBase = 'rc/cmd/';

function connectMqtt() {
  const url = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
  mqttClient = mqtt.connect(url, {
    version: 5,
    clientId: INTERNAL_MQTT_USER,
    username: INTERNAL_MQTT_USER,
    password: INTERNAL_MQTT_PASSWORD,
    clean: true,
    keepalive: 60,
    reconnectPeriod: 2000,
  });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('[MQTT] rc-api connected');
    mqttClient.subscribe('rc/state/+', { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] subscribe rc/state/+ failed:', err.message);
      else console.log('[MQTT] subscribed rc/state/+');
    });
    mqttClient.subscribe('rc/event/+', { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] subscribe rc/event/+ failed:', err.message);
      else console.log('[MQTT] subscribed rc/event/+');
    });
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = message.toString();
      if (topic.startsWith(stateTopicBase)) {
        const deviceId = topic.slice(stateTopicBase.length);
        if (deviceId) upsertDevice(deviceId, payload);
      } else if (topic.startsWith(eventTopicBase)) {
        const deviceId = topic.slice(eventTopicBase.length);
        if (deviceId) upsertDevice(deviceId, payload);
        console.log(`[EVENT] ${deviceId}: ${payload.slice(0, 200)}`);
      }
    } catch (e) {
      console.error('[MQTT] message handling error:', e.message);
    }
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT] error:', err.message);
    mqttConnected = false;
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    console.log('[MQTT] connection closed');
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] reconnecting...');
  });
}

function publishCommand(deviceId, cmdObj) {
  if (!mqttClient || !mqttConnected) {
    throw new Error('MQTT not connected');
  }
  const topic = `${cmdTopicBase}${deviceId}`;
  const payload = JSON.stringify(cmdObj);
  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ---- go-auth: /mqtt/auth ----
app.all('/mqtt/auth', (req, res) => {
  const { username, password, clientid } = req.body || {};
  if (!username || !password) {
    console.log(`[AUTH] reject: missing credentials (user=${username ? 'present' : 'missing'})`);
    return res.status(401).send('denied');
  }
  if (password === RC_ENROLL_CODE) {
    console.log(`[AUTH] accept: user=${username}`);
    return res.json({ ok: true });
  }
  console.log(`[AUTH] reject: wrong code (user=${username})`);
  res.status(401).json({ ok: false });
});

// ---- go-auth: /mqtt/superuser ----
app.all('/mqtt/superuser', (req, res) => {
  const q = req.query || {};
  const b = req.body || {};
  const username = q.username || b.username;
  const isSuper = username === INTERNAL_MQTT_USER;
  res.type('text/plain').send(isSuper ? 'true' : 'false');
});

// ---- go-auth: /mqtt/acl ----
app.post('/mqtt/acl', (req, res) => {
  const qq = req.query || {};
  const bb = req.body || {};
  const username = qq.username || bb.username;
  const topic = qq.topic || bb.topic;
  if (!username || !topic) {
    return res.json({ allow: false });
  }
  if (checkAcl(username, topic)) {
    return res.json({ result: 'allow' });
  }
  return res.json({ allow: false });
});

// ---- GET /api/devices ----
app.get('/api/devices', (_req, res) => {
  res.json({ devices: listDevices() });
});

// ---- POST /api/devices/:id/session ----
app.post('/api/devices/:id/session', (req, res) => {
  const { id: deviceId } = req.params;
  if (!deviceId || !/^[0-9a-fA-F]+$/.test(deviceId)) {
    return res.status(400).json({ error: 'invalid device id' });
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  const { token, expiresAt } = makeToken(sessionId, deviceId);
  const tokenHash = crypto.createHmac('sha256', TOKEN_SECRET).update(token).digest('hex');

  const now = new Date().toISOString();
  const safeSessionId = sqlEscape(sessionId);
  const safeDeviceId = sqlEscape(deviceId);
  const safeTokenHash = sqlEscape(tokenHash);
  const safeExpiresAt = sqlEscape(expiresAt);
  const safeNow = sqlEscape(now);
  db.exec(`INSERT OR REPLACE INTO sessions (session_id, device_id, token_hash, expires_at, created_at, closed) VALUES ('${safeSessionId}', '${safeDeviceId}', '${safeTokenHash}', '${safeExpiresAt}', '${safeNow}', 0)`);
  saveDb();

  const deviceWsUrl = `${WS_URL_PUBLIC}/relay?session=${sessionId}&role=device`;
  const viewerWsUrl = `${WS_URL_PUBLIC}/relay?session=${sessionId}&role=viewer&token=${encodeURIComponent(token)}`;

  const cmd = { cmd: 'session.start', wsUrl: deviceWsUrl, token, sessionId, viewerWsUrl };

  publishCommand(deviceId, cmd)
    .then(() => {
      console.log(`[SESSION] created ${sessionId} for device ${deviceId}, session.start published`);
      res.json({ sessionId, wsUrl: viewerWsUrl, token, expiresAt });
    })
    .catch((err) => {
      console.error('[SESSION] failed to publish session.start:', err.message);
      res.json({ sessionId, wsUrl: viewerWsUrl, token, expiresAt });
    });
});

// ---- POST /api/devices/:id/command ----
const ALLOWED_CMDS = new Set(['probe', 'selfheal', 'session.stop', 'maintenance.start', 'maintenance.stop']);

app.post('/api/devices/:id/command', (req, res) => {
  const { id: deviceId } = req.params;
  const { cmd } = req.body || {};
  if (!deviceId || !cmd || !ALLOWED_CMDS.has(cmd)) {
    return res.status(400).json({ error: 'invalid or missing command' });
  }
  publishCommand(deviceId, { cmd })
    .then(() => {
      console.log(`[CMD] ${cmd} -> ${deviceId}`);
      res.json({ ok: true, cmd, deviceId });
    })
    .catch((err) => {
      console.error(`[CMD] ${cmd} -> ${deviceId} failed:`, err.message);
      res.status(503).json({ error: 'MQTT not available' });
    });
});

// ---- GET /api/health ----
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mqtt: mqttConnected, db: !!db, timestamp: new Date().toISOString() });
});

// ---- Exported ACL check (used by /mqtt/acl route and unit tests) ----
function checkAcl(username, topic) {
  if (!username || !topic) return false;
  if (username === INTERNAL_MQTT_USER) return true;
  const re = /^rc\/(cmd|state|probe|event)\/([^/]+)$/;
  const m = topic.match(re);
  return Boolean(m && m[2] === username);
}

// ---- Exports for unit tests ----
export { upsertDevice, listDevices, makeToken, verifyToken, publishCommand, checkAcl, initDb, RC_ENROLL_CODE, INTERNAL_MQTT_USER, TOKEN_SECRET };

// Only start the server when run directly (not when imported by tests)
const IS_MAIN_API = process.argv[1] && process.argv[1].endsWith('api/index.mjs');
if (IS_MAIN_API) {
  if (!RC_ENROLL_CODE || RC_ENROLL_CODE === 'CHANGE_ME_ENROLL_CODE_HEX') {
    console.error('[FATAL] RC_ENROLL_CODE not set');
    process.exit(1);
  }
  if (!TOKEN_SECRET || TOKEN_SECRET === 'CHANGE_ME_TOKEN_SECRET_HEX') {
    console.error('[FATAL] TOKEN_SECRET not set');
    process.exit(1);
  }
  initDb()
    .then(() => {
      connectMqtt();
      app.listen(PORT, HOST, () => {
        console.log(`[API] listening on ${HOST}:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('[FATAL] init failed:', err);
      process.exit(1);
    });
}