import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { transporterForMailbox } from "@/lib/mailer-send";
import { decryptSecretOrThrow } from "@/lib/mailbox-crypto";
import { getExitNode } from "@/lib/exit-nodes";
import {
  connectionCannotBeEstablished,
  connectionFailureAsError,
  describeEnvelopeRefusal,
  describeSmtpFailure,
  formatSmtpReply,
  probeEnvelope,
  probeSmtpCapabilities,
  type SmtpEnvelopeProbe,
} from "@/lib/smtp-diagnostics";

// Same budget the pre-save route uses: the socket is already up by this point,
// so a server that goes quiet mid-envelope is answering, not timing out.
const ENVELOPE_PROBE_TIMEOUT_MS = 8_000;

/**
 * Re-test a STORED mailbox (the row's list view "Test" button). Deliberately
 * mirrors the pre-save route's diagnostics (app/api/mailboxes/test-connection)
 * so a mailbox tested here reports the same things it did before it was saved:
 * the connection timeouts come from buildSmtpTransport/transporterForMailbox
 * (lib/mailer-send.ts), and the banner + AUTH capability below turn a bare
 * green tick into evidence — the failure this exists to catch is a server that
 * never asks for a password at all, which nodemailer's verify() reports as
 * success and which silently swallows every message sent through it.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const mailbox = await prisma.mailbox.findFirst({
    where: { id, userId: session.userId },
  });
  if (!mailbox) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Exit-node config for the probe, resolved the same way the send path does.
  let proxy: { host: string; port: number } | undefined;
  if (mailbox.sendRegion) {
    const node = getExitNode(mailbox.sendRegion);
    if (node) proxy = { host: node.host, port: node.port };
  }

  const capabilities = await probeSmtpCapabilities({
    host: mailbox.host,
    port: mailbox.port,
    implicitTls: mailbox.port === 465,
    ...(proxy ? { proxy } : {}),
  });

  let ok = false;
  let error: string | undefined;
  let envelope: SmtpEnvelopeProbe | undefined;
  if (connectionCannotBeEstablished(capabilities)) {
    // Same short-circuit as the pre-save route, for the same reason: the probe's
    // connect budget IS the transport's, so a socket that never came up means
    // verify() cannot pass — report the real reason now instead of re-waiting
    // the whole connection timeout to learn the same thing.
    error = describeSmtpFailure(
      connectionFailureAsError(capabilities, { host: mailbox.host, port: mailbox.port }),
      { host: mailbox.host, port: mailbox.port, allowInsecure: mailbox.allowInsecure, capabilities }
    );
  } else {
    try {
      const transport = await transporterForMailbox(mailbox);
      await transport.verify();
      ok = true;
    } catch (e) {
      error = describeSmtpFailure(e, {
        host: mailbox.host,
        port: mailbox.port,
        allowInsecure: mailbox.allowInsecure,
        capabilities,
      });
    }

    // verify() stops at EHLO (+AUTH), so a mailbox can pass it and still be
    // incapable of sending. Offer a real envelope — MAIL FROM / RCPT TO, then
    // RSET, never DATA, so nothing is transmitted — and let the server's own
    // answer decide. A relay that takes the connection and then refuses every
    // recipient with "550 Not allowed" is the exact configuration that let a
    // live campaign report success while delivering nothing.
    if (ok) {
      try {
        envelope = await probeEnvelope({
          host: mailbox.host,
          port: mailbox.port,
          implicitTls: mailbox.port === 465,
          ...(proxy ? { proxy } : {}),
          timeoutMs: ENVELOPE_PROBE_TIMEOUT_MS,
          from: mailbox.fromAddresses[0] ?? mailbox.username,
          recipients: [...mailbox.fromAddresses, mailbox.username],
          // Decrypted the same way the transport does, so the envelope is offered
          // by an authenticated session exactly as a real send would offer it.
          auth: {
            user: mailbox.username,
            pass: decryptSecretOrThrow(mailbox.encryptedPassword, mailbox.passwordIv, mailbox.passwordTag),
          },
        });
        const refusal = describeEnvelopeRefusal(envelope, {
          host: mailbox.host,
          port: mailbox.port,
          allowInsecure: mailbox.allowInsecure,
        });
        if (refusal) {
          // Recorded as a FAILED test on purpose: the row should carry the truth,
          // because this mailbox cannot deliver and campaigns through it will not.
          ok = false;
          error = refusal;
        }
      } catch (e) {
        // Never let this extra check break a Test that already succeeded. The
        // transport just verified and authenticated fine, so the honest outcome
        // is "the send check couldn't run", not a 500 and not a false failure.
        envelope = undefined;
        void e;
      }
    }
  }

  await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: { lastTestedAt: new Date(), lastTestOk: ok },
  });

  return NextResponse.json({
    ok,
    ...(error ? { error } : {}),
    ...(ok && capabilities.reachable && !capabilities.authAdvertised
      ? {
          warning:
            "This server did not ask for a username or password at all (it advertises no AUTH), " +
            "so your credentials were never checked and messages may be accepted and then dropped " +
            "instead of relayed. If this is a real mail provider, switch to the port that requires authentication.",
        }
      : {}),
    capabilities: {
      connected: capabilities.connected,
      reachable: capabilities.reachable,
      banner: capabilities.banner,
      authAdvertised: capabilities.reachable ? capabilities.authAdvertised : null,
      authMechanisms: capabilities.authMechanisms,
      starttlsAdvertised: capabilities.reachable ? capabilities.starttlsAdvertised : null,
    },
    // `attempted: false` means the connection failed first, so the envelope
    // question was never asked — never present that as "the server said yes".
    ...(envelope
      ? {
          envelope: {
            attempted: envelope.attempted,
            accepted: envelope.accepted,
            refused: envelope.refused,
            refusedAt: envelope.refusedAt,
            reply: envelope.replyCode === null ? null : formatSmtpReply(envelope.replyCode, envelope.replyText),
          },
        }
      : {}),
  });
}
