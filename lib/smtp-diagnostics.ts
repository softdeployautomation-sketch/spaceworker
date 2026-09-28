import "server-only";
import net from "node:net";
import tls from "node:tls";
import { SocksClient } from "socks";

import { SMTP_CONNECTION_TIMEOUT_MS, SOCKS_CONNECT_TIMEOUT_MS } from "./mailer-send";

/**
 * SMTP connection diagnostics — the human-facing half of the mailbox test flow.
 *
 * Two jobs, both born from the same live incident (2026-09-28):
 *
 * 1. `probeSmtpCapabilities()` reads what a mail server ACTUALLY advertises on
 *    a given port by speaking SMTP to it directly (banner → EHLO → parse →
 *    QUIT). nodemailer's `verify()` alone can't tell you the difference between
 *    "your credentials are right" and "this server never even asked for
 *    credentials" — and that difference cost a real customer a whole campaign:
 *    the server on port 25 answers `220 localhost Python SMTP 1.4.6`, advertises
 *    NO AUTH at all, accepts every message, and relays nothing onward. nodemailer
 *    skips `login()` entirely when the server advertises no AUTH mechanism
 *    (`if (perCallAuth && (connection.allowsAuth || options.forceAuth))` in
 *    lib/smtp-transport/index.js), so `verify()` returned a cheerful `true`
 *    for a WRONG password, the mailbox showed "✓ Connection OK", and every
 *    send it made was silently swallowed. Only the server's own capability
 *    list exposes that.
 *
 * 2. `describeSmtpFailure()` turns nodemailer's terse codes (ETIMEDOUT,
 *    ESOCKET, ETLS, EAUTH…) and raw server replies into something a non-expert
 *    can act on, because "Connection timeout" after two minutes of waiting
 *    tells the user nothing about which of host/port/security is wrong.
 *
 * The probe is deliberately ADVISORY ONLY — it never decides pass/fail. A
 * server that behaves oddly over a bare probe (rate limits, EHLO quirks) must
 * not block a mailbox that nodemailer itself can happily send through, so the
 * caller always trusts `verify()` for the verdict and uses this only to enrich
 * the answer.
 *
 * The ONE deliberate exception is `connected: false` (see below), where the
 * probe's finding is not advisory but arithmetic: the socket never came up, at
 * a budget identical to the transport's own, so `verify()` cannot succeed.
 * Everything else — including `reachable: false` with `connected: true`, i.e.
 * a server that accepted the TCP connection and then went quiet — still runs
 * the real check, because nodemailer gives that conversation far more time
 * (socketTimeout) than a probe should.
 */

export interface SmtpCapabilities {
  /**
   * The TCP/TLS connection itself came up. Distinct from `reachable` on
   * purpose: `connected: false` means the transport cannot possibly succeed
   * (the connect budget here is the same constant the transport uses), so a
   * caller may skip the handshake and report this immediately. `connected:
   * true, reachable: false` means the server answered on the socket but never
   * completed an SMTP greeting — genuinely inconclusive, so the caller must
   * still let `verify()` decide.
   */
  connected: boolean;
  /** The server answered on this port at all (we read its banner). */
  reachable: boolean;
  banner: string | null;
  /** Raw EHLO capability lines, prefix stripped (e.g. "AUTH LOGIN", "SIZE 1000"). */
  capabilities: string[];
  /** The server offers STARTTLS on this port. */
  starttlsAdvertised: boolean;
  /**
   * The server offered at least one AUTH mechanism. When this is FALSE, any
   * password the user typed is ignored entirely — the send may "succeed" and
   * still deliver nothing, which is exactly the failure this exists to expose.
   */
  authAdvertised: boolean;
  authMechanisms: string[];
  /** Populated when the probe itself couldn't get an answer (advisory only). */
  error?: string;
  /**
   * The raw errno from a failed connect (ENOTFOUND, ECONNREFUSED, ETIMEDOUT…),
   * kept separate from the human-readable `error` so a caller can hand it to
   * `describeSmtpFailure` and get the specific advice (wrong hostname vs wrong
   * port vs firewall) instead of a generic timeout line.
   */
  errorCode?: string;
}

/**
 * True when the probe PROVED the connection can't be established, so the real
 * nodemailer handshake would fail identically and can be skipped. Only ever
 * true for a failed connect — see the note on `connected` above for why a
 * failed *conversation* must still go through `verify()`.
 */
export function connectionCannotBeEstablished(capabilities: SmtpCapabilities): boolean {
  return !capabilities.connected;
}

/**
 * Re-present a failed connect as an Error for `describeSmtpFailure`, carrying
 * the errno through so the advice stays specific. The message is the probe's
 * own wording, which already names what timed out and for how long.
 */
export function connectionFailureAsError(
  capabilities: SmtpCapabilities,
  ctx: { host: string; port: number }
): Error {
  const error = new Error(capabilities.error ?? `Couldn't connect to ${ctx.host}:${ctx.port}`);
  if (capabilities.errorCode) (error as NodeJS.ErrnoException).code = capabilities.errorCode;
  return error;
}

/**
 * Open a socket to the destination, optionally through a SOCKS5 exit node, and
 * optionally wrapped in implicit TLS (port 465). Returns a ready-to-talk socket
 * or throws with a message already phrased for a human.
 */
async function connectForProbe(opts: {
  host: string;
  port: number;
  implicitTls: boolean;
  proxy?: { host: string; port: number };
  timeoutMs: number;
}): Promise<net.Socket> {
  let socket: net.Socket;
  if (opts.proxy) {
    const established = await SocksClient.createConnection({
      proxy: { host: opts.proxy.host, port: opts.proxy.port, type: 5 },
      command: "connect",
      destination: { host: opts.host, port: opts.port },
      timeout: SOCKS_CONNECT_TIMEOUT_MS,
    });
    if (!established?.socket) throw new Error("the exit node did not return a usable connection");
    socket = established.socket;
  } else {
    socket = net.connect({ host: opts.host, port: opts.port });
  }

  // A raw connect that never completes is the classic black-holed-port shape
  // (SYN accepted by a middlebox, no banner ever sent) — bound it here so the
  // probe fails fast instead of inheriting nodemailer's own generous limits.
  socket.setTimeout(opts.timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`no response within ${Math.round(opts.timeoutMs / 1000)}s`));
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.off("connect", onConnect);
    }
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    if (socket.connecting) socket.once("connect", onConnect);
    else onConnect();
  });

  if (!opts.implicitTls) return socket;

  // Implicit TLS: the banner is only readable after the handshake. Certificate
  // validation is deliberately NOT the probe's job (nodemailer's verify() does
  // it properly, with the real options) — a self-signed cert must show up as a
  // cert problem from verify(), not as a confusingly absent SMTP banner here.
  const secured = tls.connect({ socket, servername: opts.host, rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      secured.destroy();
      reject(new Error(`TLS handshake did not complete within ${Math.round(opts.timeoutMs / 1000)}s`));
    };
    const onSecure = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      secured.off("error", onError);
      secured.off("timeout", onTimeout);
      secured.off("secureConnect", onSecure);
    }
    secured.once("error", onError);
    secured.once("timeout", onTimeout);
    secured.once("secureConnect", onSecure);
  });
  return secured;
}

/**
 * Read one complete SMTP reply: a possibly-multiline response terminated by a
 * line whose 4th character is a space (RFC 5321 §4.2.1). Returns the raw text
 * plus the numeric code so callers can branch on 2xx/4xx/5xx.
 */
function readReply(
  socket: net.Socket,
  timeoutMs: number
): Promise<{ code: number; text: string; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n").filter((l) => l.length > 0);
      // The reply is complete only once a line has the code + SPACE shape —
      // continuation lines use a hyphen ("250-SIZE"), the last one a space.
      if (!lines.some((l) => /^\d{3} /.test(l))) return;
      cleanup();
      resolve({ code: Number(lines[0]?.slice(0, 3) ?? 0), text: lines.join("\n"), lines });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("server stopped responding mid-conversation"));
    };
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.setTimeout(timeoutMs);
  });
}

/**
 * Ask a mail server what it supports on one port. Never throws — a failed probe
 * comes back as `{ connected: false, reachable: false, error }` so a caller can
 * always treat it as advisory. `implicitTls` must match the port convention
 * (true for 465) or the handshake is guaranteed to fail.
 *
 * The default budget is deliberately the transport's own
 * SMTP_CONNECTION_TIMEOUT_MS rather than a number of its own: it's what makes
 * `connected: false` a provable statement about the send path (a caller can
 * then skip a doomed `verify()`) instead of just a pessimistic one. Raising it
 * unilaterally would quietly break that equivalence.
 */
export async function probeSmtpCapabilities(opts: {
  host: string;
  port: number;
  implicitTls?: boolean;
  proxy?: { host: string; port: number };
  timeoutMs?: number;
}): Promise<SmtpCapabilities> {
  const timeoutMs = opts.timeoutMs ?? SMTP_CONNECTION_TIMEOUT_MS;
  const empty: SmtpCapabilities = {
    connected: false,
    reachable: false,
    banner: null,
    capabilities: [],
    starttlsAdvertised: false,
    authAdvertised: false,
    authMechanisms: [],
  };
  let socket: net.Socket | undefined;
  let connected = false;
  try {
    socket = await connectForProbe({
      host: opts.host,
      port: opts.port,
      implicitTls: opts.implicitTls === true,
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
      timeoutMs,
    });
    // Past this line the socket IS up (for 465 that includes the TLS handshake),
    // so any later failure is an SMTP conversation problem — inconclusive, and
    // the caller must let verify() have the final word.
    connected = true;

    const greeting = await readReply(socket, timeoutMs);
    if (greeting.code !== 220) {
      return {
        ...empty,
        connected,
        reachable: true,
        banner: greeting.text,
        error: `unexpected greeting ${greeting.code}`,
      };
    }
    const banner = greeting.lines[0] ?? null;

    // EHLO is what returns a capability list; a server too old to support it
    // gets one HELO retry so reachability is still confirmed (with no caps).
    socket.write("EHLO spaceworker-diagnostics\r\n");
    let reply = await readReply(socket, timeoutMs);
    if (reply.code >= 500) {
      socket.write("HELO spaceworker-diagnostics\r\n");
      reply = await readReply(socket, timeoutMs);
      return { ...empty, connected, reachable: true, banner, error: "server does not support EHLO" };
    }

    // Strip the "250-" / "250 " prefix from every line after the greeting line,
    // so what's left is the capability itself.
    const capabilities = reply.lines
      .slice(1)
      .map((l) => l.replace(/^\d{3}[- ]/, "").trim())
      .filter((l) => l.length > 0);

    const authLine = capabilities.find((c) => /^AUTH\b/i.test(c));
    const authMechanisms = authLine
      ? authLine
          .replace(/^AUTH\s*/i, "")
          .split(/\s+/)
          .filter((m) => m.length > 0)
      : [];

    // Say goodbye politely; a QUIT that fails is irrelevant to the result.
    try {
      socket.write("QUIT\r\n");
    } catch {
      /* socket already gone — the capabilities we read are still valid */
    }

    return {
      connected,
      reachable: true,
      banner,
      capabilities,
      starttlsAdvertised: capabilities.some((c) => /^STARTTLS\b/i.test(c)),
      authAdvertised: authMechanisms.length > 0,
      authMechanisms,
    };
  } catch (e) {
    // `connected` is what separates "the socket never came up" (provable, and
    // the caller may skip verify()) from "it came up and the conversation went
    // wrong" (inconclusive, verify() must decide).
    return {
      ...empty,
      connected,
      error: e instanceof Error ? e.message : "probe failed",
      ...(e && typeof e === "object" && "code" in e && typeof e.code === "string"
        ? { errorCode: e.code }
        : {}),
    };
  } finally {
    socket?.destroy();
  }
}

/**
 * Turn an SMTP failure into a sentence that names the likely cause. Kept
 * deliberately concrete (this host, this port, this mode) because the raw
 * nodemailer strings ("Connection timeout", "Error upgrading connection with
 * STARTTLS: 454 TLS not available") are unactionable to anyone who isn't
 * already an SMTP expert — which is precisely who this panel is for.
 */
export function describeSmtpFailure(
  err: unknown,
  ctx: { host: string; port: number; allowInsecure: boolean; capabilities?: SmtpCapabilities }
): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Error subclasses nodemailer sets but plain `Error` doesn't declare.
  const code = (err as { code?: string } | null)?.code ?? "";
  const combined = `${code} ${raw}`;

  if (/ETIMEDOUT|Connection timeout|timed out|no response within|timeout/i.test(combined)) {
    return (
      `Couldn't reach ${ctx.host}:${ctx.port} — the connection timed out with no reply. ` +
      `That usually means the port is blocked by a firewall. Double-check the port number: ` +
      `many providers only listen on 25, 465 or 587.`
    );
  }
  if (/ECONNREFUSED/i.test(combined)) {
    return `Nothing is listening on ${ctx.host}:${ctx.port} (connection refused). Check the port with your mail provider.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(combined)) {
    return `Couldn't resolve the hostname "${ctx.host}". Check it for typos — it should look like smtp.provider.com.`;
  }
  if (/ETLS|wrong version number|TLS not available|STARTTLS|ssl routines/i.test(combined)) {
    const noStartTls = ctx.capabilities?.reachable === true && !ctx.capabilities.starttlsAdvertised;
    return (
      `This server refused the encrypted handshake (${raw}).` +
      (noStartTls ? ` It doesn't advertise STARTTLS on port ${ctx.port} at all.` : "") +
      (ctx.allowInsecure
        ? ""
        : ` If it's a self-hosted or internal relay that has no encryption, choose "None (unencrypted)"; otherwise use the port your provider documents for encryption (usually 465 or 587).`)
    );
  }
  if (/EAUTH|Invalid login|535|534|530/i.test(combined)) {
    return `The server rejected the username or password (${raw}). Some providers need the full email address as the username, or an app-specific password.`;
  }
  return raw;
}
