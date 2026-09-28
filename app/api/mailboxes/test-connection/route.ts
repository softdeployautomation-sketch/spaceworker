import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { buildSmtpTransport } from "@/lib/mailer-send";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { validatePublicSmtpHost } from "@/lib/smtp-host-guard";
import { getExitNode } from "@/lib/exit-nodes";
import { prisma } from "@/lib/prisma";
import { canUseExitNodes } from "@/lib/premium";
import {
  connectionCannotBeEstablished,
  connectionFailureAsError,
  describeEnvelopeRefusal,
  describeSmtpFailure,
  formatSmtpReply,
  probeEnvelope,
  probeSmtpCapabilities,
  type SmtpCapabilities,
  type SmtpEnvelopeProbe,
} from "@/lib/smtp-diagnostics";

// Overall ceiling for the authoritative nodemailer handshake. The transport's
// own connection/greeting timeouts (lib/mailer-send.ts) normally fire well
// before this; this is the belt-and-braces bound so the request can never
// outlive the user's patience even if a phase stalls in a way those don't cover.
const TEST_DEADLINE_MS = 30_000;

// Budget for the envelope probe (MAIL FROM / RCPT TO / RSET). Deliberately
// shorter than the connect budget: by the time we get here the socket is already
// up and talking, so a server that goes quiet mid-envelope is answering a
// question rather than timing out on a dead port.
const ENVELOPE_PROBE_TIMEOUT_MS = 8_000;

// Task 26, Piece 5a — PRE-SAVE mailbox connection test.
// POST /api/mailboxes/test-connection   body: { host, port, username, password, allowInsecure }
//
// This is intentionally a raw, stateless check on the FORM's current values —
// exactly what the user is about to save, before any row exists / password is
// encrypted. It builds a transport through the SAME buildSmtpTransport helper a
// real send uses (so the security modes behave identically), calls
// transporter.verify(), and returns { ok: true } or { ok: false, error }.
// Nothing is persisted, no mailbox row is touched. It never transmits a message:
// the envelope probe issues MAIL FROM / RCPT TO and then aborts with RSET before
// any DATA, so it is safe to offer in both create and edit modes. The plaintext
// password never leaves the request body or crosses into any durable state.

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Task 51 — each call makes a raw outbound SMTP attempt, so cap the rate.
  const ip = await getClientIp();
  const allowed = await allowAndRecord(ip, "mailbox-test");
  if (!allowed) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  let body: {
    host?: unknown;
    port?: unknown;
    username?: unknown;
    password?: unknown;
    allowInsecure?: unknown;
    sendRegion?: unknown;
    fromAddress?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const port = Number(body.port ?? 0);
  const allowInsecure = Boolean(body.allowInsecure);
  const sendRegion = typeof body.sendRegion === "string" && body.sendRegion.trim() ? body.sendRegion.trim() : null;
  // Optional: the From address the form is configured to send as. Only used as
  // the envelope probe's recipient, so a relay service (Resend et al) that
  // refuses the bare login name but accepts the domain address is not failed.
  const fromAddress = typeof body.fromAddress === "string" ? body.fromAddress.trim() : "";

  // TASK_134 (premium) — the picker itself is visible-but-disabled for free
  // tier in the UI, but this endpoint is the actual boundary: never trust the
  // client not to send a region anyway.
  let proxy: { host: string; port: number } | undefined;
  if (sendRegion) {
    if (!(await canUseExitNodes(prisma, session.userId))) {
      return NextResponse.json({ ok: false, error: "Regional send routing is a premium feature (or has been restricted)." }, { status: 403 });
    }
    const exitNode = getExitNode(sendRegion);
    if (!exitNode) {
      return NextResponse.json({ ok: false, error: `Send region "${sendRegion}" is not available right now.` }, { status: 400 });
    }
    proxy = { host: exitNode.host, port: exitNode.port };
  }

  if (!host || !username || !password || !Number.isInteger(port) || port <= 0) {
    return NextResponse.json(
      { error: "host, port, username and password are required" },
      { status: 400 }
    );
  }

  // Task 51 — reject loopback/private/link-local/non-routable hosts BEFORE any
  // network call, so this endpoint can't be used as an internal port-scan oracle.
  // Resolves the hostname and checks its actual addresses (catches DNS-rebinding
  // too), closing the gap where a user could point it at 127.0.0.1 / the VPS's
  // own internal ranges / a cloud metadata endpoint.
  try {
    await validatePublicSmtpHost(host);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Invalid SMTP host" },
      { status: 400 }
    );
  }

  // Advisory capability probe FIRST — see lib/smtp-diagnostics.ts for the full
  // reasoning. In one extra second this is what turns "✓ Connection OK" from a
  // lie into a fact: `verify()` returns true without ever calling login() when
  // the server advertises no AUTH mechanism, so a mailbox whose server asks for
  // no password at all (the exact configuration that swallowed a live campaign)
  // otherwise looks perfectly healthy.
  const capabilities = await probeSmtpCapabilities({
    host,
    port,
    implicitTls: port === 465,
    ...(proxy ? { proxy } : {}),
  });

  // If the socket never came up, the handshake below cannot succeed — and the
  // probe's connect budget is deliberately the same constant the transport uses
  // (SMTP_CONNECTION_TIMEOUT_MS), so this is a proof rather than a guess. Report
  // it now: a blocked port used to cost the user a 120s freeze, then 18s once
  // the timeouts were bounded, and is now one honest 10s answer. Note this is
  // only the CONNECT phase — a server that opened the socket and then went quiet
  // (`connected: true, reachable: false`) still falls through to verify(), which
  // is the only thing entitled to fail a mailbox it might still be able to send
  // through.
  if (connectionCannotBeEstablished(capabilities)) {
    return NextResponse.json({
      ok: false,
      error: describeSmtpFailure(connectionFailureAsError(capabilities, { host, port }), {
        host,
        port,
        allowInsecure,
        capabilities,
      }),
      capabilities: summarizeCapabilities(capabilities),
    });
  }

  try {
    await withDeadline(
      (async () => {
        const transport = await buildSmtpTransport({ host, port, username, password, allowInsecure, proxy });
        await transport.verify();
      })(),
      TEST_DEADLINE_MS,
      `Timed out after ${Math.round(TEST_DEADLINE_MS / 1000)}s waiting for ${host}:${port} to finish the SMTP handshake.`
    );
    const warning = capabilityWarning(capabilities);

    // verify() stops at EHLO (+AUTH). This is the step that proves the mailbox
    // can actually SEND: a real MAIL FROM + RCPT TO, aborted with RSET before any
    // DATA, so no message is ever transmitted. A relay can complete EHLO,
    // advertise nothing, and then refuse every recipient with "550 Not allowed" —
    // exactly the shape that let a live campaign believe it had sent. When the
    // server says no in its own words, that IS the verdict: ok:false, not a tick
    // with a caveat.
    const envelope = await probeEnvelope({
      host,
      port,
      implicitTls: port === 465,
      ...(proxy ? { proxy } : {}),
      timeoutMs: ENVELOPE_PROBE_TIMEOUT_MS,
      from: fromAddress || username,
      recipients: [fromAddress, username].filter((a) => a.length > 0),
      // Same credentials the transport just used, so the envelope is offered by
      // an authenticated session exactly as a real send would offer it.
      auth: { user: username, pass: password },
    });
    const refusal = describeEnvelopeRefusal(envelope, { host, port, allowInsecure });
    if (refusal) {
      return NextResponse.json({
        ok: false,
        error: refusal,
        capabilities: summarizeCapabilities(capabilities),
        envelope: summarizeEnvelope(envelope),
      });
    }

    return NextResponse.json({
      ok: true,
      ...(warning ? { warning } : {}),
      capabilities: summarizeCapabilities(capabilities),
      envelope: summarizeEnvelope(envelope),
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: describeSmtpFailure(e, { host, port, allowInsecure, capabilities }),
      capabilities: summarizeCapabilities(capabilities),
    });
  }
}

/** Resolve `work`, or reject with `message` once `ms` elapses — whichever first. */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The one warning worth interrupting a green tick for: the server never asked
 * for credentials, so the password was never verified AND — far more dangerous
 * — anything sent through it may be accepted and then dropped on the floor
 * rather than relayed (confirmed live: that is exactly what port 25 on this
 * customer's host did, which is why a "successful" campaign delivered nothing,
 * not even to spam). Returns undefined when there's nothing to say.
 */
function capabilityWarning(capabilities: SmtpCapabilities): string | undefined {
  if (!capabilities.reachable || capabilities.authAdvertised) return undefined;
  return (
    "Heads-up: this server did not ask for a username or password at all " +
    "(it advertises no AUTH), so your credentials were never actually checked. " +
    "Messages may be accepted and then silently dropped instead of relayed — " +
    "if this is a real mail provider, switch to the port that requires authentication."
  );
}

/** The compact, UI-facing slice of the probe (never the raw socket state). */
function summarizeCapabilities(capabilities: SmtpCapabilities) {
  return {
    connected: capabilities.connected,
    reachable: capabilities.reachable,
    banner: capabilities.banner,
    authAdvertised: capabilities.reachable ? capabilities.authAdvertised : null,
    authMechanisms: capabilities.authMechanisms,
    starttlsAdvertised: capabilities.reachable ? capabilities.starttlsAdvertised : null,
  };
}

/**
 * The envelope probe's UI-facing slice. `attempted: false` means the question
 * was never asked (the connection failed first), which the panel must not
 * present as "the server accepted everything".
 */
function summarizeEnvelope(envelope: SmtpEnvelopeProbe) {
  return {
    attempted: envelope.attempted,
    accepted: envelope.accepted,
    refused: envelope.refused,
    refusedAt: envelope.refusedAt,
    reply: envelope.replyCode === null ? null : formatSmtpReply(envelope.replyCode, envelope.replyText),
  };
}
