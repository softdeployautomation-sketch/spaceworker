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
 * There are exactly TWO deliberate exceptions, both times because the probe's
 * finding is arithmetic rather than advisory:
 *
 *   - `connected: false` (see below): the socket never came up, at a budget
 *     identical to the transport's own, so `verify()` cannot succeed.
 *   - `probeEnvelope()` reporting `refused: true`: the server itself answered a
 *     5xx to `MAIL FROM`/`RCPT TO`. That is not a guess about what it might do —
 *     it is the server, in its own words, refusing the exact command a real send
 *     begins with. See the note on that function for the incident it came from.
 *
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
  /**
   * AUTH was already offered by the PLAINTEXT EHLO, before any TLS upgrade.
   *
   * Kept separate from `authAdvertised` purely to explain a mechanism list that
   * only exists after encryption: nearly every real submission server (verified
   * live: smtp.gmail.com:587, smtp-184101.m1.wedos.net:587) advertises NO AUTH in
   * the clear and adds `AUTH PLAIN LOGIN` only after STARTTLS. Reporting the
   * plaintext list as the whole truth is what produced the false "this server did
   * not ask for a username or password at all" warning on a mailbox that
   * authenticates and sends perfectly.
   */
  authAdvertisedBeforeTls: boolean;
  /**
   * The probe completed a STARTTLS upgrade and re-issued EHLO, so the capability
   * list (and therefore `authMechanisms`) is the POST-encryption one — the same
   * list the real transport negotiates. False for implicit-TLS ports (465), where
   * the first EHLO is already encrypted, and false when the upgrade failed (in
   * which case the plaintext capabilities are all we honestly have).
   */
  starttlsUpgraded: boolean;
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
 * The warning worth interrupting a green tick for: the server never asked for
 * credentials, so the password was never verified AND — far more dangerous —
 * anything sent through it may be accepted and then dropped on the floor rather
 * than relayed (confirmed live: that is exactly what port 25 on a customer's host
 * did, which is why a "successful" campaign delivered nothing, not even to spam).
 * Returns undefined when there's nothing to say.
 *
 * The three cases exist because the original single message was WRONG for the most
 * common server on earth. A real submission port advertises no AUTH in the clear
 * and reveals it only after STARTTLS, so a plaintext-only reading accused a
 * perfectly good provider of ignoring the password — the very false alarm this
 * warning was written to prevent, just pointing the other way. Measured live:
 * smtp.gmail.com:587 and smtp-184101.m1.wedos.net:587 (a mailbox that delivers to
 * Comcast) both answer the clear-text EHLO with no AUTH, then offer `AUTH PLAIN
 * LOGIN` once encrypted.
 *
 * Lives here rather than in a route handler because BOTH test surfaces show it,
 * and two copies of a warning string is precisely how they drift apart.
 */
export function capabilityWarning(capabilities: SmtpCapabilities): string | undefined {
  if (!capabilities.reachable || capabilities.authAdvertised) return undefined;

  // Case 1 — we encrypted the connection and re-asked; still no way to log in.
  // Now the "no AUTH" reading is a fact about an encrypted session, so the
  // warning is earned.
  if (capabilities.starttlsUpgraded) {
    return (
      "Heads-up: this server encrypted the connection but still offered no way to " +
      "log in (no AUTH, even after STARTTLS), so your username and password were " +
      "never actually checked. Messages may be accepted and then silently dropped " +
      "instead of relayed — if this is a real mail provider, switch to the port " +
      "that requires authentication."
    );
  }

  // Case 2 — STARTTLS is offered but we could not complete the upgrade. Providers
  // are required to withhold AUTH until the channel is encrypted, so we genuinely
  // do not know whether a password is required. Saying "not offered" here would be
  // a guess dressed as a finding.
  if (capabilities.starttlsAdvertised) {
    return (
      "Heads-up: this port offers STARTTLS, and mail servers are required to hide " +
      "their login list until the connection is encrypted — but the encryption " +
      "handshake did not complete from here, so we could not confirm whether your " +
      "password is used. Sending may still work normally; treat the encryption " +
      "result as the reliable part of this test."
    );
  }

  // Case 3 — no encryption and no login: the genuine accept-and-drop shape.
  return (
    "Heads-up: this server did not ask for a username or password at all " +
    "(it advertises no AUTH), so your credentials were never actually checked. " +
    "Messages may be accepted and then silently dropped instead of relayed — " +
    "if this is a real mail provider, switch to the port that requires authentication."
  );
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
    authAdvertisedBeforeTls: false,
    starttlsUpgraded: false,
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
    const authMechanismsOf = (caps: string[]) => {
      const authLine = caps.find((c) => /^AUTH\b/i.test(c));
      return authLine
        ? authLine
            .replace(/^AUTH\s*/i, "")
            .split(/\s+/)
            .filter((m) => m.length > 0)
        : [];
    };

    let capabilities = reply.lines
      .slice(1)
      .map((l) => l.replace(/^\d{3}[- ]/, "").trim())
      .filter((l) => l.length > 0);
    // What the server was willing to say IN THE CLEAR. Almost always empty on a
    // real submission port, and never the whole truth — see below.
    const authAdvertisedBeforeTls = authMechanismsOf(capabilities).length > 0;
    // Observed BEFORE any upgrade, because a server does not re-advertise STARTTLS
    // once the channel is already encrypted. Reading this after the upgrade would
    // report "STARTTLS: not offered" for a server we just used STARTTLS on.
    const starttlsAdvertised = capabilities.some((c) => /^STARTTLS\b/i.test(c));
    let starttlsUpgraded = false;

    // ── Discover AUTH the way a real send does: AFTER the TLS upgrade ──
    //
    // This is the fix for the false "no AUTH — your password isn't checked"
    // warning. A submission server is REQUIRED to withhold its AUTH list until the
    // channel is encrypted (RFC 4954 §4 / RFC 3207), so reading only the plaintext
    // EHLO reports "no AUTH" for the majority of working providers — measured live
    // on smtp.gmail.com:587 and smtp-184101.m1.wedos.net:587, both of which answer
    // the clear-text EHLO with no AUTH and then offer `AUTH PLAIN LOGIN` post-TLS.
    // The envelope probe below has always spoken this order (EHLO → STARTTLS →
    // EHLO → AUTH); the capability probe did not, which is why one test surface
    // said "accepted" while the other accused the server of ignoring the password.
    if (!opts.implicitTls && capabilities.some((c) => /^STARTTLS\b/i.test(c))) {
      try {
        socket.write("STARTTLS\r\n");
        const ready = await readReply(socket, timeoutMs);
        if (ready.code === 220) {
          socket = await upgradeProbeToTls(socket, opts.host, timeoutMs);
          starttlsUpgraded = true;
          capabilities = await ehloForProbe(socket, timeoutMs);
        }
        // A server that refuses STARTTLS is not a failure of this probe: the
        // plaintext capabilities we already hold are the honest answer, and
        // verify() owns the verdict. Deliberately not an early return — the
        // caller needs the banner and reachability it has already earned.
      } catch {
        // Upgrade failed (broken STARTTLS, or a TLS layer this probe can't
        // complete). Fall back to the plaintext list and leave
        // `starttlsUpgraded: false`, which the UI reads as "we could not see past
        // the encryption" rather than "this server forgot to ask for a password".
      }
    }

    const authMechanisms = authMechanismsOf(capabilities);

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
      starttlsAdvertised,
      authAdvertised: authMechanisms.length > 0,
      authMechanisms,
      authAdvertisedBeforeTls,
      starttlsUpgraded,
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
 * The result of actually OFFERING a message to the server and reading its
 * answer — the step `verify()` never performs.
 *
 * `verify()` stops at EHLO (plus AUTH, when the server advertises it). It
 * therefore cannot see the failure that costs a customer the most: a relay that
 * completes the handshake, advertises nothing, and then answers the very first
 * envelope command with `550 Not allowed`. That mailbox shows a green tick and
 * delivers nothing, forever — the 2026-09-28 incident, where a "successful"
 * campaign reached no inbox and no spam folder while `verify()` kept saying OK.
 */
export interface SmtpEnvelopeProbe {
  /** The conversation got far enough to offer a sender. */
  attempted: boolean;
  /** Sender and at least one recipient were accepted (2xx) — the transport can send. */
  accepted: boolean;
  /** Every recipient we offered was turned down with a 5xx. */
  refused: boolean;
  /** Which command produced the refusal. */
  refusedAt: "MAIL FROM" | "RCPT TO" | null;
  /** The server's own numeric code for the last envelope answer. */
  replyCode: number | null;
  /** The server's own words, verbatim — never paraphrased. */
  replyText: string | null;
  /** The sender we offered. */
  from: string;
  /** The recipients we offered, in the order tried (de-duplicated). */
  recipients: string[];
  /**
   * The probe upgraded to TLS (implicit on 465, or STARTTLS) before offering the
   * envelope. Recorded because a refusal read over an UNENCRYPTED session can be
   * the server demanding encryption rather than refusing the message — see the
   * guard in `describeEnvelopeRefusal`.
   */
  usedTls: boolean;
  /** The probe authenticated before offering the envelope (server advertised AUTH). */
  authenticated: boolean;
  /** Populated when the probe couldn't finish (advisory only). */
  error?: string;
}

/**
 * Say EHLO and return the capability lines, prefix-stripped. Falls back to HELO
 * for servers too old to answer EHLO, so reachability is still confirmed (with no
 * capabilities, which is itself the answer).
 */
async function ehloForProbe(socket: net.Socket, timeoutMs: number): Promise<string[]> {
  socket.write("EHLO spaceworker-diagnostics\r\n");
  const reply = await readReply(socket, timeoutMs);
  if (reply.code >= 500) {
    socket.write("HELO spaceworker-diagnostics\r\n");
    await readReply(socket, timeoutMs);
    return [];
  }
  return reply.lines
    .slice(1)
    .map((l) => l.replace(/^\d{3}[- ]/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Upgrade a plaintext probe socket to TLS with STARTTLS, exactly as a real send
 * does. Certificate validation is deliberately left to `verify()` (which uses the
 * mailbox's real options): a self-signed cert must surface as a cert problem
 * there, not as a confusingly absent envelope here.
 */
async function upgradeProbeToTls(socket: net.Socket, host: string, timeoutMs: number): Promise<tls.TLSSocket> {
  const secured = tls.connect({ socket, servername: host, rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onTimeout = () => {
      cleanup();
      secured.destroy();
      reject(new Error(`TLS handshake did not complete within ${Math.round(timeoutMs / 1000)}s`));
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
    secured.setTimeout(timeoutMs);
  });
  return secured;
}

/**
 * Log in the way the transport will, so the envelope that follows is offered by
 * an AUTHENTICATED session.
 *
 * Without this, every provider that requires a login before `MAIL FROM` (the
 * standard `530 5.7.0 Authentication required`) would be reported as refusing to
 * send, when in reality a real send — which does authenticate — is fine. Only
 * PLAIN and LOGIN are implemented; a server offering neither cannot be probed
 * honestly, and the caller treats that as inconclusive rather than a refusal.
 */
async function authenticateForProbe(
  socket: net.Socket,
  auth: { user: string; pass: string },
  mechanisms: string[],
  timeoutMs: number
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  if (mechanisms.includes("PLAIN")) {
    // RFC 4616: authorization identity (empty) NUL authcid NUL passwd.
    socket.write(`AUTH PLAIN ${b64(`\u0000${auth.user}\u0000${auth.pass}`)}\r\n`);
    const reply = await readReply(socket, timeoutMs);
    return { ok: reply.code >= 200 && reply.code < 300, reply: `${reply.code} ${reply.text.split("\n")[0]}` };
  }

  if (mechanisms.includes("LOGIN")) {
    socket.write("AUTH LOGIN\r\n");
    const challenge = await readReply(socket, timeoutMs);
    if (challenge.code !== 334) {
      return { ok: false, reply: `${challenge.code} ${challenge.text.split("\n")[0]}` };
    }
    socket.write(`${b64(auth.user)}\r\n`);
    const userStep = await readReply(socket, timeoutMs);
    if (userStep.code !== 334) {
      return { ok: false, reply: `${userStep.code} ${userStep.text.split("\n")[0]}` };
    }
    socket.write(`${b64(auth.pass)}\r\n`);
    const result = await readReply(socket, timeoutMs);
    return { ok: result.code >= 200 && result.code < 300, reply: `${result.code} ${result.text.split("\n")[0]}` };
  }

  return { ok: false, error: `server offers only AUTH ${mechanisms.join("/") || "(none)"}, which this probe cannot perform` };
}

/**
 * Offer a real envelope to the server and report what it does with it.
 *
 * Sends `MAIL FROM` then up to a few `RCPT TO`, then `RSET`. **DATA is never
 * issued**, so no message is ever transmitted and nothing can reach a real
 * inbox — which is what keeps this safe to put behind a Test button, while
 * still being the only honest answer to "can this mailbox actually send?".
 *
 * Recipients are tried in order and the probe passes as soon as ONE is accepted,
 * because relays legitimately differ in what they will take: a service like
 * Resend refuses the bare login name (`resend`) but happily accepts the domain
 * address you send as, and failing that mailbox would be a bug. Only when EVERY
 * offered recipient is refused does this report `refused: true`.
 *
 * Never throws — a failed conversation comes back as `{ error }`, which callers
 * treat as advisory so a probe hiccup can't condemn a working mailbox.
 */
export async function probeEnvelope(opts: {
  host: string;
  port: number;
  implicitTls?: boolean;
  proxy?: { host: string; port: number };
  timeoutMs?: number;
  from: string;
  recipients: string[];
  /** Credentials to authenticate with when the server advertises AUTH. */
  auth?: { user: string; pass: string };
}): Promise<SmtpEnvelopeProbe> {
  const timeoutMs = opts.timeoutMs ?? SMTP_CONNECTION_TIMEOUT_MS;

  // Dedupe case-insensitively: `username` and `fromAddresses[0]` are usually the
  // same address, and a second identical RCPT buys nothing but load on a relay
  // that may be rate-limiting us.
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const candidate of opts.recipients) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(trimmed);
  }

  const base: SmtpEnvelopeProbe = {
    attempted: false,
    accepted: false,
    refused: false,
    refusedAt: null,
    replyCode: null,
    replyText: null,
    from: opts.from,
    recipients,
    usedTls: opts.implicitTls === true,
    authenticated: false,
  };

  let socket: net.Socket | undefined;
  // Tracked as the conversation progresses so every return tells the caller how
  // honest the answer is: a refusal over an unencrypted, unauthenticated session
  // may be the server demanding exactly those things.
  let usedTls = opts.implicitTls === true;
  let authenticated = false;
  try {
    socket = await connectForProbe({
      host: opts.host,
      port: opts.port,
      implicitTls: opts.implicitTls === true,
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
      timeoutMs,
    });

    const greeting = await readReply(socket, timeoutMs);
    if (greeting.code !== 220) {
      return { ...base, error: `unexpected greeting ${greeting.code}` };
    }

    // ── Speak the same conversation a real send speaks, in the same order ──
    // EHLO → (STARTTLS → EHLO) → (AUTH) → MAIL FROM → RCPT → RSET → QUIT.
    //
    // Skipping the encryption or the login would make every refusal we read
    // meaningless, and would manufacture false failures on perfectly good
    // providers: a 587 server answers a PLAINTEXT probe with
    //     530 5.7.0 Must issue a STARTTLS command first
    // (confirmed live against smtp.gmail.com) and a login-required server answers
    // `MAIL FROM` with
    //     530 5.7.0 Authentication required
    // Both are correct answers to an unencrypted, unauthenticated question — and
    // both would have been reported as "this mailbox cannot send" by an earlier
    // draft of this probe. Only after we have encrypted and logged in exactly as
    // the transport does is a refusal actually about the mailbox.
    let capabilities = await ehloForProbe(socket, timeoutMs);

    if (!opts.implicitTls && capabilities.some((c) => /^STARTTLS\b/i.test(c))) {
      socket.write("STARTTLS\r\n");
      const ready = await readReply(socket, timeoutMs);
      if (ready.code !== 220) {
        return { ...base, error: `server refused STARTTLS with ${ready.code} ${ready.text.split("\n")[0]}` };
      }
      socket = await upgradeProbeToTls(socket, opts.host, timeoutMs);
      usedTls = true;
      capabilities = await ehloForProbe(socket, timeoutMs);
    }

    // AUTH is optional for the caller: a server that asks for no login offers the
    // envelope straight away (the customer relay on port 25), and one that asks
    // for a login must be given it or its 530 would be misread as a refusal.
    if (opts.auth && capabilities.some((c) => /^AUTH\b/i.test(c))) {
      const authLine = capabilities.find((c) => /^AUTH\b/i.test(c)) ?? "";
      const mechanisms = authLine.replace(/^AUTH\s*/i, "").split(/\s+/).filter((m) => m.length > 0).map((m) => m.toUpperCase());
      const auth = await authenticateForProbe(socket, opts.auth, mechanisms, timeoutMs);
      if (!auth.ok) {
        // `verify()` is the authority on credentials and it already passed before
        // this probe ran. If our own login attempt disagrees with it, the honest
        // answer is "inconclusive" — never a send-refusal verdict, which would
        // condemn a mailbox that sends fine.
        return { ...base, attempted: true, usedTls, error: `authentication probe failed (${auth.reply ?? auth.error})` };
      }
      authenticated = true;
    }

    socket.write(`MAIL FROM:<${opts.from}>\r\n`);
    const sender = await readReply(socket, timeoutMs);
    if (sender.code >= 500) {
      // A server that won't take our sender can never send as this mailbox, so
      // there is nothing to learn by asking about recipients.
      return {
        ...base,
        attempted: true,
        refused: true,
        refusedAt: "MAIL FROM",
        replyCode: sender.code,
        replyText: sender.text,
        usedTls,
        authenticated,
      };
    }

    let last: { code: number; text: string } | null = null;
    for (const recipient of recipients) {
      socket.write(`RCPT TO:<${recipient}>\r\n`);
      const rcpt = await readReply(socket, timeoutMs);
      last = { code: rcpt.code, text: rcpt.text };
      if (rcpt.code >= 200 && rcpt.code < 300) break;
    }

    // RSET, never DATA — this is the line that guarantees the probe cannot
    // transmit a message body to a real recipient.
    try {
      socket.write("RSET\r\n");
    } catch {
      /* socket already gone — the answers we read are still valid */
    }

    if (last && last.code >= 500) {
      return {
        ...base,
        attempted: true,
        refused: true,
        refusedAt: "RCPT TO",
        replyCode: last.code,
        replyText: last.text,
        usedTls,
        authenticated,
      };
    }
    return {
      ...base,
      attempted: true,
      accepted: last !== null && last.code >= 200 && last.code < 300,
      replyCode: last?.code ?? null,
      replyText: last?.text ?? null,
      usedTls,
      authenticated,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "probe failed" };
  } finally {
    try {
      socket?.write("QUIT\r\n");
    } catch {
      /* nothing left to say to a server that already hung up */
    }
    socket?.destroy();
  }
}

/**
 * Render a server reply for a human, without the doubled code that naive
 * concatenation produces: many servers repeat their status code inside the text
 * ("550 Not allowed" arriving under code 550), so `${code} ${text}` reads
 * "550 550 Not allowed".
 */
export function formatSmtpReply(code: number, text: string | null): string {
  const firstLine = (text ?? "").split("\n")[0].replace(/\s+/g, " ").trim();
  if (!firstLine) return String(code);
  return new RegExp(`^${code}\\b`).test(firstLine) ? firstLine : `${code} ${firstLine}`;
}

/**
 * Turn a refused envelope into the sentence that explains it, in the server's
 * own words plus the cause. Returns undefined when the server accepted — or
 * when the probe was inconclusive, in which case nothing here may speak.
 */
export function describeEnvelopeRefusal(
  probe: SmtpEnvelopeProbe,
  ctx: { host: string; port: number; allowInsecure: boolean }
): string | undefined {
  if (!probe.refused || probe.replyCode === null) return undefined;
  const reply = formatSmtpReply(probe.replyCode, probe.replyText);

  // THE FALSE-POSITIVE GUARD — the most important few lines in this function.
  //
  // A server may answer "no" simply because our session is not yet encrypted the
  // way it requires. That is a correct answer to our question, not a verdict on
  // the mailbox: the real send path would have issued STARTTLS (or connected on
  // 465) and been accepted. Confirmed live — plaintext against smtp.gmail.com:587
  // answers `530 5.7.0 Must issue a STARTTLS command first`, and an unauthenticated
  // session against a login-required server answers `530 5.7.0 Authentication
  // required`. Reporting either of those as "this mailbox cannot send" would
  // wrongly condemn every normal provider, so when we know our session was not
  // equivalent to a real send, we say nothing at all.
  const demandsStartTls = /STARTTLS/i.test(reply);
  if (demandsStartTls && !probe.usedTls) return undefined;
  // The server wanted a login we never attempted (it advertised none, or it
  // offers only a mechanism this probe cannot perform). `verify()` owns that
  // question; this probe may not answer it.
  const demandsAuth = /authentication required|authenticate first/i.test(reply) || /^530\b/.test(reply);
  if (demandsAuth && !probe.authenticated) return undefined;

  // 53x is "authenticate first / authentication required": the server wants a
  // login it gives us no way to perform. (Confirmed live: this customer's relay
  // answers AUTH with `538 5.7.11 Encryption required for requested
  // authentication mechanism` while advertising no STARTTLS at all, so there is
  // no transport on which its AUTH could ever succeed — and because we only ever
  // get here having encrypted and authenticated as far as the server allowed,
  // that conclusion is now earned rather than assumed.)
  if (/^53\d\b/.test(reply) || /authentication required|authenticate first/i.test(reply)) {
    return (
      `${ctx.host}:${ctx.port} completed the connection but refused the message: "${reply}". ` +
      `The server wants an authenticated login it never actually offers — it is set up to require ` +
      `encryption before AUTH, and it advertises no encryption on this port. No password can ever be ` +
      `accepted here, so this mailbox cannot send. Ask whoever runs the server to enable an ` +
      `authenticated submission port (587 with STARTTLS, or 465 with TLS).`
    );
  }

  // 550/551/553 are the relay-policy refusals: the server does not recognise us
  // as allowed to send. Nothing about the mailbox FORM can change that.
  if (/^55[0-3]\b/.test(reply) || /not allowed|relay access denied|relaying denied/i.test(reply)) {
    return (
      `${ctx.host}:${ctx.port} completed the connection but then refused the message with ` +
      `"${reply}" — so this mailbox cannot send, even though a connection test used to look green. ` +
      `A relay answers this for reasons that live on ITS side, not in this form: it only accepts ` +
      `mail from senders or source addresses it trusts, and our sending IP is not on that list ` +
      `(or the address is not one it hosts). Ask whoever runs the server which senders and ` +
      `source IPs it accepts from.`
    );
  }

  return (
    `${ctx.host}:${ctx.port} refused the ${probe.refusedAt ?? "message"} step with "${reply}". ` +
    `Every send through this mailbox will fail the same way.`
  );
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
