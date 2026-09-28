import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { transporterForMailbox } from "@/lib/mailer-send";
import { getExitNode } from "@/lib/exit-nodes";
import {
  connectionCannotBeEstablished,
  connectionFailureAsError,
  describeSmtpFailure,
  probeSmtpCapabilities,
} from "@/lib/smtp-diagnostics";

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
  });
}
