import "server-only";
import net from "node:net";
import nodemailer, { type Transporter } from "nodemailer";
import { SocksClient } from "socks";
import { decryptSecret } from "./mailbox-crypto";
import { validatePublicSmtpHost } from "./smtp-host-guard";
import { getExitNode } from "./exit-nodes";

export interface TransporterMailbox {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encryptedPassword: string;
  passwordIv: string;
  passwordTag: string;
  // Task 30, item 4 — the addresses to send AS. Empty/absent [] means "same as
  // username" — normal for every non-relay mailbox. Populated for a relay like
  // Resend (fixed SMTP login, specific send addresses). For the mail-queue drain,
  // each queued item's resolvedFromAddress (chosen from this array at queue-build
  // time) takes precedence; this is the fallback used by one-shot test sends.
  fromAddresses?: string[];
  // Task 26, Piece 5a — explicit opt-in to NO TLS (self-hosted/internal relays on
  // port 25 that genuinely don't support encryption). Default false; see the big
  // comment on transporterForMailbox below for why a separate flag (not the port)
  // is how "user really wants unencrypted" is represented.
  allowInsecure?: boolean;
  // TASK_134 (premium) — route the underlying TCP connection through one of
  // SpaceWorker's regional SOCKS5 exit nodes ("us" | "ca" | "uk", see
  // lib/exit-nodes.ts) instead of connecting directly from this server's own
  // (European datacenter) IP. null/undefined = direct, the default.
  sendRegion?: string | null;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  // Task 26, Piece 5a — the ONLY way to disable enforced TLS. See the
  // transporterForMailbox comment above; this exists for self-hosted/internal
  // relays that genuinely don't speak any TLS (port 25 "None" mode).
  allowInsecure?: boolean;
  // TASK_134 — when set, the raw TCP connection to host:port is established
  // THROUGH this SOCKS5 exit first; TLS/STARTTLS/AUTH negotiation on top of it
  // is completely unchanged — only the socket's origin moves. See
  // lib/exit-nodes.ts for the available nodes.
  proxy?: { host: string; port: number };
}

// ---------------------------------------------------------------------------
// Connection timeouts (added 2026-09-28, mailbox-test triage).
//
// Confirmed live against a real customer mailbox: `smtp-host:587` on a server
// that answers on 24610/25 but silently black-holes 587 (SYN accepted, never a
// RST, never a banner) made "Test connection" sit on "Testing…" for 120.015s
// before reporting `ETIMEDOUT Connection timeout`. Nothing in this codebase
// ever set these, so nodemailer's defaults applied — and its default
// `connectionTimeout` is 2 MINUTES, with `socketTimeout` at 10 MINUTES.
//
// That is the wrong failure shape for both callers: the test button looks
// frozen for two minutes, and a real campaign send pointed at a dead port
// would stall the queue for ten. A healthy provider answers all three phases
// in well under a second, so every value here is a CEILING on a phase, not an
// expected duration.
//
//   - connection: max wait for the TCP connect (+ TLS handshake, when implicit).
//   - greeting:   max wait for the server's 220 banner and its EHLO reply.
//   - socket:     max INACTIVITY once established. Deliberately far looser than
//                 the other two (and than any human watching a test) because
//                 this same transport also drives real campaign sends: a large
//                 HTML body going out over a slow link must never be cut short
//                 just to make a test feel snappier. The test route applies its
//                 own tighter overall deadline on top instead.
// ---------------------------------------------------------------------------
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 60_000;
// The SOCKS5 handshake + the exit node's own connect to the destination. The
// `socks` package's default is 30s, measured live as a misleading
// "Proxy connection timed out" long after the user had given up.
export const SOCKS_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Build a nodemailer SMTP transport from raw connection options — the shared
 * single source of truth for correct TLS negotiation. Used for BOTH stored
 * mailboxes (transporterForMailbox below) and the pre-save "Test connection"
 * button (app/api/mailboxes/test-connection/route.ts), whose inputs are raw
 * form values, not yet persisted / encrypted. Keeping the logic in this one
 * helper means the test the user gets before saving is byte-identical to the
 * connection a real send will use.
 *
 * `secure` here is deliberately NOT taken from any stored checkbox value.
 * Confirmed live: a real Brevo SMTP relay account (smtp-relay.brevo.com:587)
 * failed with "SSL routines: tls_validate_record_header:wrong version number"
 * -- the classic symptom of sending a TLS ClientHello to a server that expects
 * a plaintext SMTP greeting first. Nodemailer's `secure: true` means IMPLICIT
 * TLS (the connection is TLS from the first byte) -- correct ONLY for port
 * 465. Port 587 (what Brevo, Gmail, and most providers actually use) is
 * STARTTLS: the client connects in plaintext, then explicitly upgrades via the
 * STARTTLS command. The old single "Use TLS" checkbox defaulting to checked
 * meant EVERY mailbox added on port 587 was silently attempting the wrong
 * handshake style. The fix is universal SMTP convention, not a per-provider
 * special case: port 465 => implicit TLS; everything else => STARTTLS,
 * enforced (not merely opportunistic) via `requireTLS` so a misconfigured
 * server fails loudly instead of silently sending credentials in plaintext.
 * The one deliberate exception is allowInsecure (the explicit "None" mode),
 * which relaxes requireTLS for genuinely unencrypted internal relays.
 */
export async function buildSmtpTransport(opts: SmtpTransportOptions): Promise<Transporter> {
  const implicitTls = opts.port === 465;
  // TASK_134 — SocksClient.createConnection() does the SOCKS5 handshake and
  // hands back an already-connected raw net.Socket; nodemailer's `connection`
  // option accepts exactly that (SMTPConnectionOptions.connection?: net.Socket
  // in @types/nodemailer) and does its own TLS/STARTTLS/AUTH on top of it
  // completely unchanged — `host`/`port` are still passed alongside it (used
  // for the EHLO greeting and TLS SNI, not for opening the socket, once
  // `connection` is set).
  let connection: net.Socket | undefined;
  if (opts.proxy) {
    try {
      const established = await SocksClient.createConnection({
        proxy: { host: opts.proxy.host, port: opts.proxy.port, type: 5 },
        command: "connect",
        destination: { host: opts.host, port: opts.port },
        timeout: SOCKS_CONNECT_TIMEOUT_MS,
      });
      // `socks` resolves with { socket: null } rather than rejecting in some
      // failure shapes, so check both — a null socket would otherwise surface
      // as an opaque "Cannot read properties of null" from deep inside
      // nodemailer instead of naming the exit node as the problem.
      if (!established?.socket) throw new Error("the exit node did not return a usable connection");
      connection = established.socket;
    } catch (e) {
      const detail = e instanceof Error ? e.message : "unknown error";
      throw new Error(
        `Couldn't reach ${opts.host}:${opts.port} through the send region's exit node ` +
          `(${opts.proxy.host}:${opts.proxy.port}) — ${detail}`
      );
    }
  }
  return nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: implicitTls,
    requireTLS: !implicitTls && !opts.allowInsecure,
    auth: { user: opts.username, pass: opts.password },
    // See the timeout block above the doc comment — these are what turn a
    // black-holed port from a 2-minute freeze into a fast, clear failure.
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    ...(connection ? { connection } : {}),
  });
}

export async function transporterForMailbox(mailbox: TransporterMailbox): Promise<Transporter> {
  // Task 51 — guard the REAL send path too, not just save/test time. Save-time
  // validation (app/api/mailboxes/route.ts) stops NEW private-IP mailboxes from
  // being stored, but a mailbox saved before the fix could otherwise drive an
  // outbound connection straight at an internal address. Resolve + validate the
  // host here before building any transport, then connect.
  await validatePublicSmtpHost(mailbox.host);
  const password = decryptSecret(
    mailbox.encryptedPassword,
    mailbox.passwordIv,
    mailbox.passwordTag
  );
  // TASK_134 — resolve the mailbox's chosen region to a real, currently-
  // configured exit node. Fails LOUDLY (never silently falls back to direct)
  // when the region is set but unavailable: a user who explicitly picked a
  // region did so for a reason (e.g. a domain that specifically blocks the
  // direct server IP), so silently sending direct instead could look like
  // success while quietly defeating the whole point.
  let proxy: { host: string; port: number } | undefined;
  if (mailbox.sendRegion) {
    const exitNode = getExitNode(mailbox.sendRegion);
    if (!exitNode) {
      throw new Error(`Send region "${mailbox.sendRegion}" is not available right now.`);
    }
    proxy = { host: exitNode.host, port: exitNode.port };
  }
  return buildSmtpTransport({
    host: mailbox.host,
    port: mailbox.port,
    username: mailbox.username,
    password,
    allowInsecure: mailbox.allowInsecure,
    proxy,
  });
}