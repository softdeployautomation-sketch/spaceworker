/**
 * Clone egress ingress (TASK_118 B8-3) — the server half of the dial-out relay.
 *
 * WHY THIS EXISTS: the work-PC relay binds loopback (cmd/relay), which our
 * hosted clone browser (a container on this box) can never reach. The old
 * comment claiming that traffic was "replayed over the Mesh tunnel" described
 * something never implemented — no TCP tunnel exists in either repo — so
 * `egress: relay` had no data path at all, only a health probe. This ingress is
 * that data path, inverted: the work PC dials US, so it needs no inbound port,
 * no firewall rule and no router change.
 *
 * ONE LISTENER, TWO ROLES, told apart by the first bytes:
 *
 *   work PC -> "<SWRELAY/1> <token> <key>\n"             control conn (stays open)
 *   work PC -> "<SWRELAY/1> <token> <key> DATA <id>\n"   one conn per stream
 *   browser -> "CONNECT host:443 HTTP/1.1" + Proxy-Authorization
 *
 * Control carries only stream setup ("NEW <id>"); every proxied connection gets
 * its own outbound conn, so there is NO multiplexing — the browser's HTTP is
 * never framed inside a shared socket and a slow body cannot stall other tabs.
 *
 * TRUST: the device handshake is gated by the shared ingress token (compared in
 * constant time). Browser conns are gated by a per-job routing credential the
 * launcher registers in memory — the username is an informational label and the
 * PASSWORD is the routing secret, so a caller cannot pick a device merely by
 * guessing a device id. Browser conns are additionally restricted to private
 * (container bridge) sources: work PCs arrive from public IPs and must never be
 * able to use this as an open forward proxy.
 */
import { createServer, type Server, type Socket } from "net";
import { randomBytes, timingSafeEqual } from "crypto";

/** Handshake prefix; must match tunnelProto in cmd/relay/tunnel.go. */
const TUNNEL_PROTO = "SWRELAY/1";
/** Control frames are tiny; anything larger is a broken/hostile peer. */
const FRAME_LIMIT = 4096;
/** HTTP request head cap (Chromium never sends more). */
const HEAD_LIMIT = 16 * 1024;
const HEAD_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 10_000;
const DEFAULT_ROUTE_TTL_MS = 12 * 60 * 60 * 1000;
/** Keepalive so home-router NAT mappings survive an idle clone. */
const CONTROL_PING_MS = 20_000;

export interface RelayIngressOptions {
  bind: string;
  port: number;
  token: string;
  /** TTL for routes registered without an explicit one. */
  routeTtlMs?: number;
  /**
   * Only accept browser-path conns from private sources (the Neko container
   * reaches us over the docker bridge). Default true; the local harness
   * relaxes it.
   */
  browserPrivateOnly?: boolean;
  log?: (msg: string) => void;
}

export interface RelayIngressHandle {
  server: Server;
  /**
   * Register the routing credential a clone browser presents as its proxy
   * password. Called by the launcher — the only code that knows which device a
   * session egresses through.
   */
  addRoute(routingSecret: string, deviceKey: string, ttlMs?: number): void;
  removeRoute(routingSecret: string): void;
  stats(): { controls: number; routes: number; streams: number };
  close(): Promise<void>;
}

interface Control {
  socket: Socket;
  connectedAt: number;
  ping: NodeJS.Timeout;
}

interface Waiter {
  resolve: (socket: Socket) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function isPrivateSource(addr: string | undefined): boolean {
  if (!addr) return false;
  // IPv4-mapped IPv6 (::ffff:172.17.0.2) is what Node reports for bridge peers.
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  const octets = v4.split(".").map((n) => Number(n));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Length is compared (and leaked) first — unavoidable, and harmless for a
  // fixed-length shared secret; timingSafeEqual then gates the bytes.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** base64(user:pass) -> {user, pass}, without throwing on hostile input. */
function parseBasicProxyAuth(head: Buffer): { user: string; pass: string } | null {
  const match = /^proxy-authorization:\s*basic\s+([A-Za-z0-9+/=]+)\s*$/im.exec(head.toString("latin1"));
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

export function startRelayIngress(opts: RelayIngressOptions): RelayIngressHandle {
  const log = opts.log ?? (() => {});
  const routeTtlMs = opts.routeTtlMs ?? DEFAULT_ROUTE_TTL_MS;
  const privateOnly = opts.browserPrivateOnly !== false;

  const controls = new Map<string, Control>();
  const routes = new Map<string, { deviceKey: string; expiresAt: number }>();
  const waiters = new Map<string, Waiter>();
  // Every accepted conn is tracked so close() can end deterministically: a
  // lingering tunnel conn must not hold the process open on shutdown/restart.
  const openSockets = new Set<Socket>();
  let streamCount = 0;

  const expireRoutes = () => {
    const now = Date.now();
    for (const [secret, route] of routes) if (route.expiresAt <= now) routes.delete(secret);
  };

  /**
   * Read a conn's first bytes and return BOTH the role decision and the
   * complete head. Sniffing and head-reading share one buffer on purpose: the
   * head that comes back is forwarded verbatim, so no byte can be lost between
   * deciding the role and splicing (the "corked socket" class of bug).
   */
  function readHead(socket: Socket, timeoutMs: number): Promise<{ tunnel: boolean; head: Buffer }> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let tunnel: boolean | null = null;
      const finish = (err?: Error) => {
        cleanup();
        if (err) reject(err);
        else resolve({ tunnel: tunnel === true, head: buf });
      };
      const onReadable = () => {
        let chunk: Buffer | null;
        while ((chunk = socket.read()) !== null) {
          buf = Buffer.concat([buf, chunk]);
          if (tunnel === null) {
            const probe = buf.toString("latin1", 0, Math.min(buf.length, TUNNEL_PROTO.length));
            // A partial prefix that still matches stays UNDECIDED, so a slow
            // handshake is never misread as HTTP.
            if (TUNNEL_PROTO.startsWith(probe) && buf.length < TUNNEL_PROTO.length + 1) continue;
            tunnel = probe === TUNNEL_PROTO;
          }
          if (tunnel ? buf.includes(0x0a) : buf.includes("\r\n\r\n")) return finish();
          if (buf.length > (tunnel ? FRAME_LIMIT : HEAD_LIMIT)) return finish(new Error("head_too_large"));
        }
      };
      const onGone = () => finish(new Error("closed_before_head"));
      const timer = setTimeout(() => finish(new Error("head_timeout")), timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        socket.off("readable", onReadable);
        socket.off("close", onGone);
        socket.off("error", onGone);
      }
      socket.on("readable", onReadable);
      socket.once("close", onGone);
      socket.once("error", onGone);
    });
  }

  /** Line reader for the long-lived control conn, after its handshake. */
  function attachControlReader(socket: Socket, onLine: (line: string) => void, onEnd: () => void) {
    let buf = Buffer.alloc(0);
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = socket.read()) !== null) {
        buf = Buffer.concat([buf, chunk]);
        let idx = buf.indexOf(0x0a);
        while (idx !== -1) {
          onLine(buf.subarray(0, idx).toString("utf8").replace(/\r$/, ""));
          buf = buf.subarray(idx + 1);
          idx = buf.indexOf(0x0a);
        }
        if (buf.length > FRAME_LIMIT) {
          log("relay-ingress: control frame overflow, dropping conn");
          socket.destroy();
          return;
        }
      }
    };
    socket.on("readable", onReadable);
    socket.once("close", onEnd);
    socket.once("error", onEnd);
  }

  function dropControl(deviceKey: string, socket: Socket) {
    const existing = controls.get(deviceKey);
    if (existing && existing.socket === socket) {
      clearInterval(existing.ping);
      controls.delete(deviceKey);
    }
  }

  function registerControl(socket: Socket, deviceKey: string) {
    // Last-wins: a reconnecting work PC can briefly overlap its predecessor,
    // and routing a new stream to a dead control would stall every launch.
    const prev = controls.get(deviceKey);
    if (prev) {
      clearInterval(prev.ping);
      prev.socket.destroy();
    }
    const ping = setInterval(() => {
      if (socket.writable) socket.write("PING\n");
    }, CONTROL_PING_MS);
    ping.unref?.();
    controls.set(deviceKey, { socket, connectedAt: Date.now(), ping });
    socket.write("OK\n");
    log(`relay-ingress: control up for key ${deviceKey.slice(0, 8)}… (${controls.size} live)`);
    // A dropping conn emits BOTH 'error' and 'close' (observed live 2026-09-25:
    // "control down" logged twice per disconnect), so end exactly once.
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      dropControl(deviceKey, socket);
      log(`relay-ingress: control down for key ${deviceKey.slice(0, 8)}…`);
    };
    attachControlReader(
      socket,
      (line) => {
        if (line === "" || line === "PONG") return;
        log(`relay-ingress: unexpected control frame from device: ${line.slice(0, 60)}`);
      },
      onEnd,
    );
  }

  function resolveRoute(routingSecret: string): string | null {
    expireRoutes();
    const route = routes.get(routingSecret);
    return route ? route.deviceKey : null;
  }

  /** Ask the work PC for a dedicated conn for ONE proxied connection. */
  function openStream(deviceKey: string): Promise<Socket> {
    const control = controls.get(deviceKey);
    if (!control || !control.socket.writable) {
      return Promise.reject(new Error("device_relay_offline"));
    }
    const id = randomBytes(8).toString("hex");
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error("device_relay_timeout"));
      }, STREAM_TIMEOUT_MS);
      waiters.set(id, { resolve, reject, timer });
      control.socket.write(`NEW ${id}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          waiters.delete(id);
          reject(new Error("device_relay_write_failed"));
        }
      });
    });
  }

  function refuse(socket: Socket, status: number, reason: string, extra = "") {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
    }
    socket.end();
  }

  /** Work-PC conn: control handshake or a DATA conn claiming a stream id. */
  function handleTunnelLine(socket: Socket, head: Buffer, peer: string) {
    const line = head.subarray(0, head.indexOf(0x0a)).toString("utf8").trim();
    // SWRELAY/1 <token> <key> [DATA <id>]
    const [, token, key, mode, streamId] = line.split(/\s+/);
    if (!token || !key || !opts.token || !safeEqual(token, opts.token)) {
      log(`relay-ingress: rejected handshake from ${peer}`);
      socket.destroy();
      return;
    }
    if (mode === "DATA") {
      const waiter = streamId ? waiters.get(streamId) : undefined;
      if (!waiter) {
        // Cannot happen when we register the waiter BEFORE sending NEW
        // (openStream does), so this is a protocol violation, not a race.
        log(`relay-ingress: unclaimed stream ${streamId ?? "?"} from ${key.slice(0, 8)}…`);
        socket.destroy();
        return;
      }
      clearTimeout(waiter.timer);
      waiters.delete(streamId);
      waiter.resolve(socket);
      return;
    }
    registerControl(socket, key);
  }

  async function handleBrowser(socket: Socket, head: Buffer, peer: string) {
    if (privateOnly && !isPrivateSource(socket.remoteAddress)) {
      // Public sources are work PCs (which must dial out) — never a proxy.
      log(`relay-ingress: refused non-private proxy conn from ${peer}`);
      refuse(socket, 403, "Forbidden");
      return;
    }
    const auth = parseBasicProxyAuth(head);
    const deviceKey = auth ? resolveRoute(auth.pass) : null;
    if (!deviceKey) {
      log(`relay-ingress: bad routing credential from ${peer}`);
      refuse(socket, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="sw-relay"\r\n');
      return;
    }

    let device: Socket;
    try {
      device = await openStream(deviceKey);
    } catch (err) {
      log(`relay-ingress: ${err instanceof Error ? err.message : "stream_failed"} (key ${deviceKey.slice(0, 8)}…)`);
      refuse(socket, 502, "Bad Gateway");
      return;
    }

    streamCount += 1;
    // The head we buffered IS the start of the proxied stream: forward it
    // verbatim, then splice. Nothing replayed, nothing dropped.
    device.write(head);
    socket.pipe(device);
    device.pipe(socket);
    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      streamCount -= 1;
      socket.destroy();
      device.destroy();
    };
    socket.once("close", teardown);
    device.once("close", teardown);
    socket.once("error", teardown);
    device.once("error", teardown);
    socket.resume();
    device.resume();
  }

  const server = createServer((socket) => {
    const peer = socket.remoteAddress ?? "?";
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    socket.pause(); // no byte is consumed until we are ready to keep it
    socket.setNoDelay(true); // proxy streams are latency-sensitive
    socket.once("error", () => socket.destroy());
    readHead(socket, HEAD_TIMEOUT_MS).then(
      ({ tunnel, head }) => {
        if (tunnel) handleTunnelLine(socket, head, peer);
        else void handleBrowser(socket, head, peer).catch(() => socket.destroy());
      },
      () => socket.destroy(),
    );
  });

  server.listen(opts.port, opts.bind, () => {
    log(`relay-ingress: listening on ${opts.bind}:${opts.port} (private-only browser path: ${privateOnly})`);
  });

  return {
    server,
    addRoute(routingSecret: string, deviceKey: string, ttlMs = routeTtlMs) {
      routes.set(routingSecret, { deviceKey, expiresAt: Date.now() + ttlMs });
    },
    removeRoute(routingSecret: string) {
      routes.delete(routingSecret);
    },
    stats() {
      expireRoutes();
      return { controls: controls.size, routes: routes.size, streams: streamCount };
    },
    close() {
      for (const control of controls.values()) {
        clearInterval(control.ping);
        control.socket.destroy();
      }
      controls.clear();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("ingress_closed"));
      }
      waiters.clear();
      // Destroy accepted conns so a work PC's idle control conn cannot keep the
      // listener (and the process) alive through a restart.
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

