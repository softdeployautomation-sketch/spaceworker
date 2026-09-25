import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { startRelayIngress, type RelayIngressHandle } from "./relay-ingress";

// TASK_118 B8-3 — dial-out egress ingress tests.
//
// The work PC dials OUT to the ingress (no inbound port on a customer machine),
// so these tests play BOTH sides: a fake device speaking the tunnel protocol
// and a browser conn speaking HTTP proxy. Tests that need the REAL relay client
// use RELAY_BIN (a built cmd/relay) and skip when it is absent, so this suite
// stays runnable without a Go toolchain.

const TOKEN = "test-ingress-token";
const KEY = "device-key-1";
const ROUTE = "route-secret-1";

interface IngressCtx {
  ingress: RelayIngressHandle;
  port: number;
  close: () => Promise<void>;
}

async function startIngress(overrides: Partial<Parameters<typeof startRelayIngress>[0]> = {}): Promise<IngressCtx> {
  const ingress = startRelayIngress({
    bind: "127.0.0.1",
    port: 0, // ephemeral: tests never collide with a real deployment
    token: TOKEN,
    ...overrides,
  });
  await new Promise<void>((resolve) => ingress.server.once("listening", resolve));
  const addr = ingress.server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { ingress, port: addr.port, close: () => ingress.close() };
}

/** Line-splitter for control conns (node has no readline on raw sockets). */
function lineReader(socket: Socket) {
  let buf = Buffer.alloc(0);
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx = buf.indexOf(0x0a);
    while (idx !== -1) {
      const line = buf.subarray(0, idx).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      idx = buf.indexOf(0x0a);
    }
  });
  return {
    next(): Promise<string> {
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
    pending: () => lines.length,
  };
}

/**
 * Fake work PC: speaks the tunnel protocol and answers each NEW by dialling a
 * DATA conn. `onStream` decides what the "device" does with that proxied conn
 * (default: reply with a canned HTTP response, which is enough to prove the
 * ingress spliced browser bytes to the device-dialled conn).
 */
async function startFakeDevice(opts: {
  port: number;
  token?: string;
  key?: string;
  sendHandshakeInParts?: boolean;
  onStream?: (data: Socket) => void;
}): Promise<{ control: Socket; controlLine: string; streams: Socket[]; close: () => void }> {
  const socket = connect(opts.port, "127.0.0.1");
  const reader = lineReader(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const handshake = `SWRELAY/1 ${opts.token ?? TOKEN} ${opts.key ?? KEY}\n`;
  if (opts.sendHandshakeInParts) {
    // Split INSIDE the protocol prefix: a naive sniffer that decides on the
    // first chunk would misread this as HTTP and the handshake would hang.
    socket.write(handshake.slice(0, 4));
    await new Promise((r) => setTimeout(r, 40));
    socket.write(handshake.slice(4));
  } else {
    socket.write(handshake);
  }
  const ack = await reader.next();
  const streams: Socket[] = [];
  void (async () => {
    for (;;) {
      const line = await reader.next().catch(() => "");
      if (!line) return;
      const [tag, id] = line.split(/\s+/);
      if (tag !== "NEW") continue;
      const data = connect(opts.port, "127.0.0.1");
      await new Promise<void>((resolve) => data.once("connect", resolve));
      data.write(`SWRELAY/1 ${opts.token ?? TOKEN} ${opts.key ?? KEY} DATA ${id}\n`);
      streams.push(data);
      if (opts.onStream) {
        opts.onStream(data);
      } else {
        data.once("data", () => data.write("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nDEVICE-ECHO"));
      }
    }
  })();
  return {
    control: socket,
    controlLine: ack,
    streams,
    close: () => {
      socket.destroy();
      for (const s of streams) s.destroy();
    },
  };
}

/** Send one absolute-form HTTP request through the ingress proxy path. */
function proxyGet(
  port: number,
  target: string,
  credential: string | null,
  path = "/",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: target + path,
      headers: credential ? { "Proxy-Authorization": `Basic ${credential}` } : {},
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const basic = (user: string, pass: string) => Buffer.from(`${user}:${pass}`).toString("base64");

test("device control handshake is acknowledged and browser bytes reach the DEVICE-dialled conn", async () => {
  const ctx = await startIngress();
  try {
    ctx.ingress.addRoute(ROUTE, KEY);
    const device = await startFakeDevice({ port: ctx.port });
    assert.equal(device.controlLine, "OK", "ingress must acknowledge the dial-out handshake");

    const res = await proxyGet(ctx.port, "http://example.test", basic("job-1", ROUTE));
    assert.equal(res.status, 200);
    assert.equal(res.body, "DEVICE-ECHO", "response must come from the device conn, not the ingress");
    assert.equal(device.streams.length, 1, "exactly one DATA conn per proxied connection");
    assert.deepEqual(ctx.ingress.stats(), { controls: 1, routes: 1, streams: 1 });
    device.close();
  } finally {
    await ctx.close();
  }
});

test("handshake split inside the protocol prefix is NOT misread as HTTP (sniff boundary)", async () => {
  const ctx = await startIngress();
  try {
    ctx.ingress.addRoute(ROUTE, KEY);
    const device = await startFakeDevice({ port: ctx.port, sendHandshakeInParts: true });
    assert.equal(device.controlLine, "OK");
    const res = await proxyGet(ctx.port, "http://example.test", basic("job-1", ROUTE));
    assert.equal(res.body, "DEVICE-ECHO");
    device.close();
  } finally {
    await ctx.close();
  }
});

test("device with the wrong token is refused without an OK", async () => {
  const ctx = await startIngress();
  try {
    const socket = connect(ctx.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(`SWRELAY/1 wrong-token ${KEY}\n`);
    await closed; // destroyed, not acknowledged
    assert.equal(ctx.ingress.stats().controls, 0);
    socket.destroy();
  } finally {
    await ctx.close();
  }
});

test("browser conn without a routing credential gets 407 and never touches a device", async () => {
  const ctx = await startIngress();
  try {
    ctx.ingress.addRoute(ROUTE, KEY);
    const device = await startFakeDevice({ port: ctx.port });
    const res = await proxyGet(ctx.port, "http://example.test", null);
    assert.equal(res.status, 407);
    assert.equal(device.streams.length, 0);
    const guessed = await proxyGet(ctx.port, "http://example.test", basic("job-1", "not-the-route"));
    assert.equal(guessed.status, 407);
    assert.equal(device.streams.length, 0, "a guessed credential must not select a route");
    device.close();
  } finally {
    await ctx.close();
  }
});

test("route registered but no device connected yields 502 (not a hang)", async () => {
  const ctx = await startIngress();
  try {
    ctx.ingress.addRoute(ROUTE, KEY);
    const res = await proxyGet(ctx.port, "http://example.test", basic("job-1", ROUTE));
    assert.equal(res.status, 502);
  } finally {
    await ctx.close();
  }
});

test("expired route stops resolving", async () => {
  const ctx = await startIngress();
  try {
    ctx.ingress.addRoute(ROUTE, KEY, 30);
    const device = await startFakeDevice({ port: ctx.port });
    await new Promise((r) => setTimeout(r, 80));
    const res = await proxyGet(ctx.port, "http://example.test", basic("job-1", ROUTE));
    assert.equal(res.status, 407);
    assert.equal(device.streams.length, 0);
    device.close();
  } finally {
    await ctx.close();
  }
});

test("DATA conn claiming an unknown stream id is dropped as a protocol violation", async () => {
  const ctx = await startIngress();
  try {
    const socket = connect(ctx.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(`SWRELAY/1 ${TOKEN} ${KEY} DATA deadbeefdeadbeef\n`);
    await closed;
    assert.deepEqual(ctx.ingress.stats(), { controls: 0, routes: 0, streams: 0 });
    socket.destroy();
  } finally {
    await ctx.close();
  }
});

test("plain HTTP request head is forwarded byte-for-byte (nothing eaten by sniffing)", async () => {
  const ctx = await startIngress();
  let device: Awaited<ReturnType<typeof startFakeDevice>> | null = null;
  try {
    ctx.ingress.addRoute(ROUTE, KEY);
    let seen = "";
    device = await startFakeDevice({
      port: ctx.port,
      onStream: (data) => {
        data.once("data", (buf) => {
          seen += buf.toString("utf8");
          data.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
        });
      },
    });
    const res = await proxyGet(ctx.port, "http://example.test", basic("job-1", ROUTE), "/path?q=1");
    assert.equal(res.status, 200);
    // Head AND tail must survive: a sniffer that consumes the leading bytes
    // corrupts the request line; one that stops early truncates the final
    // header + terminator. Both are checked (node sets Host to the proxy, so
    // the assertion targets the proxy-auth header, which WE sent).
    assert.match(seen, /^GET http:\/\/example\.test\/path\?q=1 HTTP\/1\.1\r\n/);
    assert.match(seen, /\r\nProxy-Authorization: Basic am9iLTE6cm91dGUtc2VjcmV0LTE=\r\n/);
    assert.match(seen, /\r\n\r\n$/, "head must end with the blank line, not be truncated");
  } finally {
    device?.close();
    await ctx.close();
  }
});


// ---------------------------------------------------------------------------
// Integration: the REAL relay client (cmd/relay) dialling out to the ingress,
// proxying to a live origin. Needs RELAY_BIN (a built cmd/relay) because the
// tunnel client is Go; skipped when absent so this suite runs without Go.
// ---------------------------------------------------------------------------

const RELAY_BIN = process.env.RELAY_BIN;

/** Live origin that records what it received and answers with a marker. */
function startOrigin(): Promise<{ port: number; last: () => Record<string, unknown>; close: () => void }> {
  let last: Record<string, unknown> = {};
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      last = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ORIGIN-MARKER-7f3a");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, last: () => last, close: () => server.close() });
    });
  });
}

function spawnRelay(args: string[]): { kill: () => void; out: () => string } {
  const child = spawn(RELAY_BIN as string, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (c) => (out += c));
  child.stderr?.on("data", (c) => (out += c));
  return { kill: () => child.kill("SIGKILL"), out: () => out };
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("REAL relay client dials out, ingress delegates, origin is reached through the device", { skip: !RELAY_BIN }, async () => {
  const ctx = await startIngress();
  const origin = await startOrigin();
  ctx.ingress.addRoute(ROUTE, KEY);
  let relay: ReturnType<typeof spawnRelay> | null = null;
  try {
    relay = spawnRelay([
      "-addr",
      "127.0.0.1:0", // the listener is irrelevant in tunnel mode; port 0 = no clash
      "-token",
      TOKEN,
      "-tunnel",
      `127.0.0.1:${ctx.port}`,
      "-tunnel-key",
      KEY,
    ]);
    await waitFor(() => ctx.ingress.stats().controls === 1, 5000, "relay control conn");

    // Plain HTTP through the proxy: the origin can ONLY have been reached by
    // whoever the ingress delegated to (the relay), never by the ingress itself.
    const res = await proxyGet(ctx.port, `http://127.0.0.1:${origin.port}`, basic("job-1", ROUTE), "/hello?x=1");
    assert.equal(res.status, 200);
    assert.equal(res.body, "ORIGIN-MARKER-7f3a");
    assert.equal(origin.last().url, "/hello?x=1", "origin saw the proxied request line");
  } finally {
    relay?.kill();
    origin.close();
    await ctx.close();
  }
});

test("REAL relay preserves request BODY through sniff + head + splice", { skip: !RELAY_BIN }, async () => {
  const ctx = await startIngress();
  const origin = await startOrigin();
  ctx.ingress.addRoute(ROUTE, KEY);
  let relay: ReturnType<typeof spawnRelay> | null = null;
  try {
    relay = spawnRelay(["-addr", "127.0.0.1:0", "-token", TOKEN, "-tunnel", `127.0.0.1:${ctx.port}`, "-tunnel-key", KEY]);
    await waitFor(() => ctx.ingress.stats().controls === 1, 5000, "relay control conn");
    const payload = "PAYLOAD-MARKER-9c21";
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: ctx.port,
        method: "POST",
        path: `http://127.0.0.1:${origin.port}/post`,
        headers: {
          "Proxy-Authorization": `Basic ${basic("job-1", ROUTE)}`,
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(payload),
          "X-SW-Test": "body-survives",
        },
      });
      req.on("response", (r) => {
        let out = "";
        r.on("data", (c) => (out += c));
        r.on("end", () => resolve(out));
      });
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(body, "ORIGIN-MARKER-7f3a");
    const seen = origin.last();
    assert.equal(seen.body, payload, "request body must survive the tunnel intact");
    assert.equal(seen.method, "POST");
    assert.equal((seen.headers as Record<string, string>)["x-sw-test"], "body-survives");
  } finally {
    relay?.kill();
    origin.close();
    await ctx.close();
  }
});


test("REAL relay CONNECT tunnel splices raw bytes end-to-end", { skip: !RELAY_BIN }, async () => {
  const ctx = await startIngress();
  const origin = await startOrigin();
  ctx.ingress.addRoute(ROUTE, KEY);
  let relay: ReturnType<typeof spawnRelay> | null = null;
  try {
    relay = spawnRelay(["-addr", "127.0.0.1:0", "-token", TOKEN, "-tunnel", `127.0.0.1:${ctx.port}`, "-tunnel-key", KEY]);
    await waitFor(() => ctx.ingress.stats().controls === 1, 5000, "relay control conn");

    // CONNECT is what a browser uses for HTTPS. The relay dials the origin and
    // hijacks; we then speak HTTP inside the tunnel, which proves the splice is
    // byte-transparent without needing TLS.
    const socket = connect(ctx.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.write(
      `CONNECT 127.0.0.1:${origin.port} HTTP/1.1\r\n` +
        `Proxy-Authorization: Basic ${basic("job-1", ROUTE)}\r\n\r\n`,
    );
    const text = () => Buffer.concat(chunks).toString("utf8");
    await waitFor(() => text().includes("200 Connection Established"), 5000, "CONNECT 200");
    socket.write(`GET /inside-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\nConnection: close\r\n\r\n`);
    await waitFor(() => text().includes("ORIGIN-MARKER-7f3a"), 5000, "tunnelled response");
    assert.equal(origin.last().url, "/inside-tunnel");
    socket.destroy();
  } finally {
    relay?.kill();
    origin.close();
    await ctx.close();
  }
});

test("REAL relay death surfaces as 502 for the browser (device offline, no hang)", { skip: !RELAY_BIN }, async () => {
  const ctx = await startIngress();
  const origin = await startOrigin();
  ctx.ingress.addRoute(ROUTE, KEY);
  let relay: ReturnType<typeof spawnRelay> | null = null;
  try {
    relay = spawnRelay(["-addr", "127.0.0.1:0", "-token", TOKEN, "-tunnel", `127.0.0.1:${ctx.port}`, "-tunnel-key", KEY]);
    await waitFor(() => ctx.ingress.stats().controls === 1, 5000, "relay control conn");
    const ok = await proxyGet(ctx.port, `http://127.0.0.1:${origin.port}`, basic("job-1", ROUTE), "/before");
    assert.equal(ok.status, 200);

    relay.kill();
    await waitFor(() => ctx.ingress.stats().controls === 0, 5000, "control teardown after relay death");
    const gone = await proxyGet(ctx.port, `http://127.0.0.1:${origin.port}`, basic("job-1", ROUTE), "/after");
    assert.equal(gone.status, 502, "a dead work PC must fail fast, not hang the browser");
  } finally {
    relay?.kill();
    origin.close();
    await ctx.close();
  }
});

test("REAL relay reconnects after the ingress restarts (survives our deploys)", { skip: !RELAY_BIN }, async () => {
  const first = await startIngress();
  const origin = await startOrigin();
  first.ingress.addRoute(ROUTE, KEY);
  const relay = spawnRelay(["-addr", "127.0.0.1:0", "-token", TOKEN, "-tunnel", `127.0.0.1:${first.port}`, "-tunnel-key", KEY]);
  let second: IngressCtx | null = null;
  try {
    await waitFor(() => first.ingress.stats().controls === 1, 5000, "initial control conn");
    const port = first.port;
    await first.close(); // simulating our side restarting
    // Same port, fresh listener: the relay's backoff must re-establish control.
    second = await startIngress({ port });
    second.ingress.addRoute(ROUTE, KEY);
    await waitFor(() => second!.ingress.stats().controls === 1, 8000, "reconnected control conn");
    const res = await proxyGet(second.port, `http://127.0.0.1:${origin.port}`, basic("job-1", ROUTE), "/after-restart");
    assert.equal(res.status, 200);
    assert.equal(origin.last().url, "/after-restart");
  } finally {
    relay.kill();
    origin.close();
    await first.close().catch(() => {});
    await second?.close().catch(() => {});
  }
});

