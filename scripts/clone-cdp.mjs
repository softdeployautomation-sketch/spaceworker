#!/usr/bin/env node
/**
 * clone-cdp.mjs — talk to a clone browser's DevTools endpoint (TASK_117 / B7).
 *
 * Zero dependencies on purpose: this must run on the VPS (or a laptop) with
 * nothing installed but node — no `npm i ws`.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS — do not "simplify" it:
 *
 *   1. Target the BROWSER endpoint (/devtools/browser/<id>) and use
 *      browser-level methods (Storage.setCookies, Target.createTarget).
 *   2. A direct /devtools/page/<id> socket COMPLETES the handshake and answers
 *      ping/pong, but SILENTLY IGNORES EVERY COMMAND — no reply, no error, no
 *      close. It looks exactly like a dead network. Never use it.
 *   3. Target.attachToTarget returns {"code":-32000,"message":"Not allowed"} on
 *      the clone image, so the usual "attach + sessionId" pattern is NOT
 *      available.
 *   4. The HTTP client socket stays CORKED across an upgrade, so writes buffer
 *      and never reach the wire. Uncorking is mandatory; without it the command
 *      is never sent and the await hangs forever with no events at all.
 *
 *   See TASK_117_HOSTED_POOL_PROVISIONING.md → "D1 FINDINGS" F5/F6 for the
 *   measurements behind each of these.
 *
 * Usage:
 *   node scripts/clone-cdp.mjs probe  --port <cdpPort>
 *   node scripts/clone-cdp.mjs inject --port <cdpPort> --cookies <file.json> [--url <url>]
 *
 * Options:
 *   --port <n>       Local TCP port that reaches the clone's CDP endpoint.
 *                    Inside the container this is a loopback forwarder (e.g.
 *                    9223 -> 9222). Reach it from off-host with `ssh -L`, e.g.
 *                    ssh -L 19402:127.0.0.1:19402 root@<vps>
 *   --cookies <f>    JSON file: [{ "name": ..., "value": ..., "domain": ...,
 *                    "path": "/", "expires": <epoch s, optional> }]
 *   --url <u>        Open this URL after injecting (default: inject only).
 *   --list           With `inject`, also print the cookies DevTools reports.
 *   --timeout <ms>   Per-request timeout (default 10000).
 *
 * Exit codes: 0 ok · 1 usage · 2 connect/handshake · 3 CDP error · 4 timeout.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const EXIT = { OK: 0, USAGE: 1, CONNECT: 2, CDP: 3, TIMEOUT: 4 };

// NOTE: deliberately `exitCode`, NOT `code`. Node system errors already carry a
// STRING `code` (e.g. 'ECONNREFUSED'), so `process.exit(e.code)` throws
// validateInteger and masks the real failure.
const fail = (message, exitCode) => Object.assign(new Error(message), { exitCode });

// ---------------------------------------------------------------- raw WebSocket
// Minimal RFC 6455 client: enough for CDP (text frames + ping/pong + close).
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.raw = Buffer.alloc(0);
    this.fragOp = 0;
    this.frags = [];
    this.closed = false;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.onError = () => {};

    // THE CORK FIX — see header note 4.
    if (typeof socket.uncork === 'function') socket.uncork();
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    });
    socket.on('error', (e) => {
      if (this.closed) return;
      this.closed = true;
      this.onError(e);
    });
    socket.resume();
  }

  #frame(opcode, payload) {
    // Client frames MUST be masked (RFC 6455 §5.3).
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, body]);
  }

  sendText(str) {
    if (this.closed) throw new Error('socket closed');
    return this.socket.write(this.#frame(0x1, Buffer.from(str)));
  }

  #onData(chunk) {
    this.raw = Buffer.concat([this.raw, chunk]);
    for (;;) {
      if (this.raw.length < 2) return;
      const fin = (this.raw[0] & 0x80) !== 0;
      const opcode = this.raw[0] & 0x0f;
      const masked = (this.raw[1] & 0x80) !== 0;
      let len = this.raw[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.raw.length < 4) return;
        len = this.raw.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.raw.length < 10) return;
        len = Number(this.raw.readBigUInt64BE(2));
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.raw.length < off + 4) return;
        maskKey = this.raw.subarray(off, off + 4);
        off += 4;
      }
      if (this.raw.length < off + len) return;
      const payload = Buffer.from(this.raw.subarray(off, off + len));
      this.raw = this.raw.subarray(off + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];

      if (opcode === 0x9) {
        this.socket.write(this.#frame(0xa, payload)); // ping -> pong
        continue;
      }
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x8) {
        this.socket.end();
        continue;
      }
      if (opcode === 0x0) this.frags.push(payload);
      else {
        this.fragOp = opcode;
        this.frags = [payload];
      }
      if (fin) {
        const full = Buffer.concat(this.frags);
        this.frags = [];
        if (this.fragOp === 0x1) this.onMessage(full.toString('utf8'));
      }
    }
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(this.#frame(0x8, Buffer.alloc(0)));
    } catch {
      /* already gone */
    }
    this.socket.end();
  }
}

function wsConnect(port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(fail(`no response from 127.0.0.1:${port}${path}`, EXIT.TIMEOUT));
    }, timeoutMs);

    req.on('response', (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () =>
        reject(fail(`not upgraded: HTTP ${res.statusCode} ${body.slice(0, 200)}`, EXIT.CONNECT)),
      );
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(fail(e.message, EXIT.CONNECT));
    });
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer);
      const expect = crypto
        .createHash('sha1')
        .update(key + GUID)
        .digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        reject(fail('bad Sec-WebSocket-Accept', EXIT.CONNECT));
        return;
      }
      resolve(new WsConn(socket));
    });
    req.end();
  });
}

// ------------------------------------------------------------------- CDP client
class Cdp {
  constructor(ws, timeoutMs) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.pending = new Map();
    ws.onMessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    };
    const abortPending = (err) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    ws.onClose = () => abortPending(new Error('socket closed by peer'));
    ws.onError = (e) => abortPending(e);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail(`${method} timed out after ${this.timeoutMs}ms`, EXIT.TIMEOUT));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.sendText(JSON.stringify({ id, method, params }));
    });
  }

  /** Send and throw on a CDP-level error object. */
  async call(method, params = {}) {
    const res = await this.send(method, params);
    if (res.error) {
      const e = fail(`${method}: ${res.error.message}`, EXIT.CDP);
      e.cdp = res.error;
      throw e;
    }
    return res.result;
  }
}

// ---------------------------------------------------------------------- helpers
function httpJson(port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(fail(`${path} did not return JSON (HTTP ${res.statusCode})`, EXIT.CONNECT));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(fail(`${path} timed out`, EXIT.TIMEOUT));
    });
    req.on('error', (e) => reject(fail(e.message, EXIT.CONNECT)));
    req.end();
  });
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      'usage:',
      '  node scripts/clone-cdp.mjs probe  --port <cdpPort>',
      '  node scripts/clone-cdp.mjs inject --port <cdpPort> --cookies <file.json> [--url <url>] [--list]',
      '  node scripts/clone-cdp.mjs export --port <cdpPort> (--out <file.json> [--domain <d>] [--list] | --domains)',
      '',
      'export reads cookies OUT of a live Chrome (the clone SOURCE). It is the only',
      'supported capture path on Chrome 127+, which encrypts values with App-Bound',
      'Encryption ("v20") — see TASK_117 D1 FINDINGS F7. Use --domains first to see',
      'which domains exist (names/counts only, never values).',
      '',
      'The --port must reach the clone browser\'s DevTools endpoint (a loopback',
      'forwarder inside the container, e.g. 9223 -> 9222). From off-host use an',
      'ssh tunnel: ssh -L 19402:127.0.0.1:19402 <user>@<host>',
    ].join('\n'),
  );
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const out = { cmd: argv[0], cookies: null, url: null, list: false, timeout: 10000, port: null, out: null, domain: null, domains: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--cookies') out.cookies = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--domains') out.domains = true;
    else if (a === '--list') out.list = true;
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown argument: ${a}`);
  }
  return out;
}

async function browserEndpoint(port, timeoutMs) {
  const version = await httpJson(port, '/json/version', timeoutMs);
  const browserId = (version.webSocketDebuggerUrl || '').split('/devtools/browser/')[1];
  if (!browserId) {
    throw fail('no webSocketDebuggerUrl in /json/version', EXIT.CONNECT);
  }
  console.log(`browser=${version.Browser}`);
  const ws = await wsConnect(port, `/devtools/browser/${browserId}`, timeoutMs);
  return { ws, cdp: new Cdp(ws, timeoutMs), browserId };
}

// -------------------------------------------------------------------- commands
async function probe(args) {
  const { ws, cdp } = await browserEndpoint(args.port, args.timeout);
  const v = await cdp.call('Browser.getVersion');
  console.log(`product=${v.product}`);
  const targets = await cdp.call('Target.getTargets');
  const pages = (targets.targetInfos || []).filter((t) => t.type === 'page');
  console.log(`pages=${pages.length}`);
  for (const p of pages) console.log(`  page ${p.url}`);
  console.log('probe=OK');
  ws.close();
  return EXIT.OK;
}

async function inject(args) {
  if (!args.cookies) usage('inject requires --cookies <file.json>');
  const raw = JSON.parse(fs.readFileSync(args.cookies, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.cookies;
  if (!Array.isArray(list) || list.length === 0) usage('cookie file must be a non-empty array');

  const now = Math.floor(Date.now() / 1000);
  const cookies = list.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : now + 60 * 60 * 24 * 30,
    ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
    ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
  }));

  const { ws, cdp } = await browserEndpoint(args.port, args.timeout);

  // Browser-level method — deliberately NOT session-scoped (see header note 3).
  await cdp.call('Storage.setCookies', { cookies });
  console.log(`setCookies=${cookies.length}`);

  if (args.list) {
    const got = await cdp.call('Storage.getCookies', {});
    const names = new Set(cookies.map((c) => c.name));
    const mine = (got.cookies || []).filter((c) => names.has(c.name));
    console.log(`verified=${mine.length}`);
    for (const c of mine) console.log(`  ${c.name}@${c.domain}${c.path}`);
  }

  if (args.url) {
    if (/[\r\n]/.test(args.url)) usage('url must not contain newlines');
    const t = await cdp.call('Target.createTarget', { url: args.url });
    console.log(`opened=${args.url}`);
    if (t && t.targetId) console.log(`targetId=${t.targetId}`);
  }

  console.log('inject=OK');
  ws.close();
  return EXIT.OK;
}

/**
 * export — read cookies OUT of a live Chrome via CDP.
 *
 * This exists because disk-level capture is dead on modern Chrome. Chrome 127+
 * writes cookie values with App-Bound Encryption ("v20"), whose key never leaves
 * the browser process, so reading Cookies.sqlite + Local State and decrypting
 * out-of-process CANNOT work (TASK_117 → D1 FINDINGS F7). Asking the browser
 * itself over CDP is the only supported route, and it also reaches
 * localStorage/sessionStorage later.
 *
 * Privacy: with --domains we print only domain names + counts. Without it we
 * write the full jar, so it is opt-in and loud.
 */
async function exportCookies(args) {
  const { ws, cdp } = await browserEndpoint(args.port, args.timeout);
  const got = await cdp.call('Storage.getCookies', {});
  const all = got.cookies || [];
  console.log(`cookies_total=${all.length}`);

  // Discovery mode — never prints values.
  if (args.domains) {
    const counts = new Map();
    for (const c of all) counts.set(c.domain, (counts.get(c.domain) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [d, n] of sorted) console.log(`  ${n}\t${d}`);
    ws.close();
    return EXIT.OK;
  }

  let picked = all;
  if (args.domain) {
    const want = args.domain.replace(/^\./, '').toLowerCase();
    picked = all.filter((c) => {
      const d = (c.domain || '').replace(/^\./, '').toLowerCase();
      return d === want || d.endsWith(`.${want}`);
    });
    console.log(`cookies_matched=${picked.length} (domain=${args.domain})`);
  }
  if (picked.length === 0) throw fail('no cookies matched', EXIT.CDP);

  const out = picked.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
    ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
    ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  }));
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  console.log(`wrote=${args.out} mode=0600`);
  if (args.list) for (const c of out) console.log(`  ${c.name}@${c.domain}${c.path}`);
  console.log('export=OK');
  ws.close();
  return EXIT.OK;
}

// ------------------------------------------------------------------------ main
const args = parseArgs(process.argv.slice(2));
if (!args.cmd) usage();
if (!Number.isInteger(args.port) || args.port <= 0) usage('--port is required');

const CMD = { probe, inject, export: exportCookies };
if (!CMD[args.cmd]) usage(`unknown command: ${args.cmd}`);
if (args.cmd === 'export' && !args.domains && !args.out) usage('export requires --out <file.json>');

try {
  process.exit(await CMD[args.cmd](args));
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(typeof e.exitCode === 'number' ? e.exitCode : EXIT.CDP);
}
