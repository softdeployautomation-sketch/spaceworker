// ---- imports ----
import { WebSocket } from 'ws';
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import { once } from 'node:events';
import Aedes from 'aedes';
import { Server as NetServer } from 'net';
import { spawn } from 'child_process';

// ---- constants ----
const PORT_API = 8094;
const PORT_RELAY = 8084;
const PORT_MQTT = 1884;
const DEVICE_ID = 'deadbeef12345678';
const ENROLL_CODE = 'test-enroll-code-do-not-use';
const TOKEN_SECRET = 'test-token-secret-do-not-use';

process.env.RC_ENROLL_CODE = ENROLL_CODE;
process.env.TOKEN_SECRET = TOKEN_SECRET;
process.env.API_PORT = PORT_API;
process.env.API_HOST = '127.0.0.1';
process.env.MQTT_HOST = '127.0.0.1';
process.env.MQTT_PORT = PORT_MQTT;
process.env.DB_PATH = './data/test-fake-device.sqlite';
process.env.WS_URL_PUBLIC = `ws://127.0.0.1:${PORT_RELAY}`;
process.env.RELAY_PORT = PORT_RELAY;
process.env.RELAY_HOST = '127.0.0.1';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`PASS: ${msg}`);
}

const JPEG_1X1 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4,
  0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05,
  0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04,
  0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22,
  0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15,
  0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17,
  0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36,
  0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
  0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95,
  0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
  0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2,
  0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5,
  0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
  0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x01, 0x26, 0x9c,
  0x80, 0x00, 0xff, 0xd9,
]);

function packHeader(type, pts) {
  const buf = Buffer.alloc(9);
  buf.writeUInt8(type, 0);
  buf.writeBigUInt64BE(BigInt(pts), 1);
  return buf;
}

function packJpegFrame(pts, jpeg) {
  return Buffer.concat([packHeader(0x04, pts), jpeg]);
}
// ---- Start aedes MQTT broker ----
const aedes = new Aedes();
const netServer = new NetServer(aedes.handle);
await new Promise((res) => netServer.listen(PORT_MQTT, '127.0.0.1', res));
console.log(`[E2E] aedes broker on 127.0.0.1:${PORT_MQTT}`);

// ---- Start API server ----
const apiChild = spawn('node', ['api/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, RC_ENROLL_CODE: ENROLL_CODE, TOKEN_SECRET },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});
const apiProc = { pid: apiChild.pid };

for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT_API}/api/health`);
    if (res.ok) break;
  } catch { /* not ready yet */ }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`[E2E] api server (pid ${apiProc}) on 127.0.0.1:${PORT_API}`);

// ---- Start relay server ----
const relayChild = spawn('node', ['relay/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, TOKEN_SECRET },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});
const relayProc = { pid: relayChild.pid };
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT_RELAY}/`);
    if (res.ok) break;
  } catch { /* not ready yet */ }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`[E2E] relay server (pid ${relayProc}) on 127.0.0.1:${PORT_RELAY}`);

// ---- Fake device: MQTT + relay client ----
let mqttClient;
let relayWs = null;
let sessionStartReceived = false;

const mqttUrl = `mqtt://127.0.0.1:${PORT_MQTT}`;
mqttClient = mqtt.connect(mqttUrl, {
  version: 5, clientId: DEVICE_ID, username: DEVICE_ID,
  password: ENROLL_CODE, clean: true, keepalive: 60,
});

await once(mqttClient, 'connect');
console.log('[E2E] fake device MQTT connected');

await new Promise((res) => mqttClient.subscribe(`rc/cmd/${DEVICE_ID}`, { qos: 1 }, res));

const statePayload = JSON.stringify({ online: true, version: '1.4.5-test', caps: { h264: false } });
mqttClient.publish(`rc/state/${DEVICE_ID}`, statePayload, { retain: true, qos: 1 });

mqttClient.on('message', (topic, message) => {
  if (topic === `rc/cmd/${DEVICE_ID}`) {
    try {
      const cmd = JSON.parse(message.toString());
      console.log('[E2E] device received cmd:', cmd.cmd);
      if (cmd.cmd === 'session.start') {
        sessionStartReceived = true;
        connectDeviceRelay(cmd.wsUrl, cmd.token);
      }
    } catch { /* ignore */ }
  }
});

// ---- Viewer relay client ----
let viewerWs = null;
let viewerReceivedJpeg = false;
let viewerReceivedTouch = false;

function connectDeviceRelay(wsUrl, token) {
  const url = `${wsUrl}&token=${encodeURIComponent(token)}`;
  relayWs = new WebSocket(url);
  relayWs.binaryType = 'arraybuffer';
  relayWs.onopen = () => {
    console.log('[E2E] device relay WS open');
    const frame = packJpegFrame(1000, JPEG_1X1);
    relayWs.send(frame);
    relayWs.send(JSON.stringify({ t: 'log', msg: 'hello' }));
    console.log('[E2E] device sent JPEG 0x04 + log');
  };
  relayWs.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'touch') {
          viewerReceivedTouch = true;
          console.log('[E2E] device received touch:', JSON.stringify(msg));
        }
      } catch { /* ignore */ }
    }
  };
  relayWs.onclose = () => { relayWs = null; };
}

function connectViewerRelay(token) {
  const url = `ws://127.0.0.1:${PORT_RELAY}/relay?role=viewer&session=${encodeURIComponent(sessionData.sessionId)}&token=${encodeURIComponent(token)}`;
  viewerWs = new WebSocket(url);
  viewerWs.binaryType = 'arraybuffer';
  return new Promise((res, rej) => {
    viewerWs.onopen = () => {
      viewerWs.send(JSON.stringify({ t: 'hello' }));
      viewerWs.send(JSON.stringify({ t: 'viewer.join' }));
      res();
    };
    viewerWs.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const buf = Buffer.from(ev.data);
        if (buf.length >= 9 && buf.readUInt8(0) === 0x04) {
          viewerReceivedJpeg = true;
          console.log(`[E2E] viewer received JPEG ${buf.length - 9} bytes`);
        }
      }
    };
    viewerWs.onerror = rej;
  });
}

// ---- E2E flow ----
// 1. Call POST /api/devices/:id/session to create session
const sessionRes = await fetch(`http://127.0.0.1:${PORT_API}/api/devices/${DEVICE_ID}/session`, {
  method: 'POST',
});
assert(sessionRes.ok, 'POST /api/devices/:id/session returns 200');
const sessionData = await sessionRes.json();
assert(sessionData.sessionId, 'session has sessionId');
assert(sessionData.wsUrl, 'session has wsUrl');

// 2. Wait for session.start to reach device
await new Promise((r) => setTimeout(r, 1000));
assert(sessionStartReceived, 'device received session.start via MQTT');

// 3. Connect viewer to relay
await connectViewerRelay(sessionData.token);

// 4. Wait for JPEG to arrive at viewer
await new Promise((r) => setTimeout(r, 1000));
assert(viewerReceivedJpeg, 'viewer received JPEG 0x04 frame');

// 5. Viewer sends touch
viewerWs.send(JSON.stringify({ t: 'touch', action: 'down', nx: 0.5, ny: 0.5, pointerId: 1 }));

// 6. Wait for touch to reach device
await new Promise((r) => setTimeout(r, 1000));
assert(viewerReceivedTouch, 'device received touch from viewer');

// ---- Summary ----
console.log(`\n=== E2E: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures === 0 ? 0 : 1);