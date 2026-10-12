// Tests for the CDP client's two silent-failure defects, fixed 2026-09-28.
//
// A FAKE CDP SERVER, not a mock of the client. The defects were about how a real
// protocol message was interpreted, so this test speaks the real protocol: a
// WebSocket handshake, masked client frames, unmasked server frames, and JSON-RPC
// envelopes carrying either `result` or `error`. Mocking the client's own parser
// would have preserved the very bug the parser contained.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { exportCookies, injectCookies } from "./cdp";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Unmasks one client frame; returns the text and the bytes consumed. */
function parseClientFrame(buf: Buffer): { text: string; consumed: number } | null {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { text: payload.toString("utf8"), consumed: off + len };
}

/** A server frame — never masked, because that is the client's job. */
function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

interface FakeCdp {
  port: number;
  close: () => Promise<void>;
  /** Every command the client sent, in order. */
  seen: string[];
}

/**
 * Starts a fake DevTools endpoint.
 *
 * `respond` decides what one command returns: a `result`, or an `error` — which
 * is how the real browser reports a command it rejected.
 */
async function startFakeCdp(
  respond: (
    method: string,
    params: Record<string, unknown>,
  ) => { result?: unknown; error?: { code: number; message: string } },
): Promise<FakeCdp> {
  const seen: string[] = [];
  // Every upgraded socket is tracked and DESTROYED on close. Without this the
  // client's own close frame is not answered by the fake server, the socket
  // stays open, and the test runner waits on it forever — which is how this
  // suite first behaved.
  const sockets = new Set<import("node:stream").Duplex>();
  let port = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: "Chrome/fake",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE`,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let raw = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      for (;;) {
        const frame = parseClientFrame(raw);
        if (!frame) return;
        raw = raw.subarray(frame.consumed);
        let msg: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(frame.text);
        } catch {
          continue;
        }
        if (typeof msg.method !== "string" || typeof msg.id !== "number") continue;
        seen.push(msg.method);
        socket.write(serverFrame(JSON.stringify({ id: msg.id, ...respond(msg.method, msg.params ?? {}) })));
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("exportCookies reads the jar out of the command RESULT", async () => {
  // The defect: the TS port resolved the whole message, so `result.cookies` was
  // undefined and every readback returned an empty list — for every browser,
  // always. That is what made a broken cookie carry look like "no cookies
  // arrived", which is a completely different diagnosis.
  const fake = await startFakeCdp(() => ({
    result: {
      cookies: [
        { name: "session", value: "abc", domain: ".example.com", path: "/" },
        { name: "other", value: "def", domain: ".other.test", path: "/" },
      ],
    },
  }));
  try {
    const all = await exportCookies({ port: fake.port, timeoutMs: 3000 });
    assert.equal(all.length, 2, "the jar must not come back empty");
    assert.deepEqual(all.map((c) => c.name).sort(), ["other", "session"]);
    // Domain filtering still works, on the real jar.
    const only = await exportCookies({ port: fake.port, domain: "example.com", timeoutMs: 3000 });
    assert.deepEqual(only.map((c) => c.name), ["session"]);
  } finally {
    await fake.close();
  }
});

test("a CDP error is a REJECTION, never a success", async () => {
  // The defect: `Storage.setCookies` could fail outright and the caller was told
  // `ok: true, count: 2` — a clone reported as signed in over an empty jar.
  const fake = await startFakeCdp(() => ({
    error: { code: -32000, message: "Cookies are not allowed" },
  }));
  try {
    await assert.rejects(
      () =>
        injectCookies({
          port: fake.port,
          cookies: [{ name: "a", value: "b", domain: ".x.test", path: "/" }],
          timeoutMs: 3000,
        }),
      /CDP Storage\.setCookies failed \(-32000\): Cookies are not allowed/,
    );
  } finally {
    await fake.close();
  }
});

test("injectCookies reports what the jar ACTUALLY holds, not what was sent", async () => {
  // The browser accepts both cookies but keeps one — a rejected or immediately
  // expired cookie is the real-world case. The count must follow the jar.
  const fake = await startFakeCdp((method) => {
    if (method === "Storage.setCookies") return { result: {} };
    return { result: { cookies: [{ name: "kept", value: "v", domain: ".example.com", path: "/" }] } };
  });
  try {
    const res = await injectCookies({
      port: fake.port,
      cookies: [
        { name: "kept", value: "v", domain: ".example.com", path: "/" },
        { name: "dropped", value: "v", domain: ".example.com", path: "/" },
      ],
      timeoutMs: 3000,
    });
    assert.deepEqual(res, { ok: true, count: 1 });
  } finally {
    await fake.close();
  }
});

test("injectCookies fails closed when the jar stays empty", async () => {
  const fake = await startFakeCdp((method) => {
    if (method === "Storage.setCookies") return { result: {} };
    return { result: { cookies: [] } };
  });
  try {
    const res = await injectCookies({
      port: fake.port,
      cookies: [{ name: "a", value: "b", domain: ".x.test", path: "/" }],
      timeoutMs: 3000,
    });
    assert.equal(res.ok, false, "an empty jar must never be reported as a successful injection");
    assert.equal(res.count, 0);
  } finally {
    await fake.close();
  }
});

test("injectCookies actually issues setCookies then getCookies", async () => {
  const fake = await startFakeCdp((method) => {
    if (method === "Storage.setCookies") return { result: {} };
    return { result: { cookies: [{ name: "a", value: "b", domain: ".x.test", path: "/" }] } };
  });
  try {
    const res = await injectCookies({
      port: fake.port,
      cookies: [{ name: "a", value: "b", domain: ".x.test", path: "/" }],
      timeoutMs: 3000,
    });
    assert.equal(res.ok, true);
    // The readback is not optional: it is what turns "we sent them" into "the
    // browser holds them", so both commands must really be on the wire.
    assert.deepEqual(fake.seen, ["Storage.setCookies", "Storage.getCookies"]);
  } finally {
    await fake.close();
  }
});

