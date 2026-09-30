import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import { validatePublicSmtpHost } from "@/lib/smtp-host-guard";
import { getExitNode } from "@/lib/exit-nodes";
import { canUseExitNodes } from "@/lib/premium";
import { Prisma } from "@prisma/client"; // value import — the DELETE handler needs
                                            // Prisma.PrismaClientKnownRequestError at runtime

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const existing = await prisma.mailbox.findFirst({
    where: { id, userId: session.userId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: {
    label?: string; host?: string; port?: number; username?: string;
    fromAddresses?: unknown; password?: string; secure?: boolean; dailyLimit?: number; active?: boolean; allowInsecure?: boolean;
    sendRegion?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Prisma.MailboxUpdateInput = {};
  if (body.label !== undefined) data.label = String(body.label).trim();
  if (body.host !== undefined) data.host = String(body.host).trim();
  if (body.port !== undefined) data.port = Number(body.port);
  if (body.username !== undefined) data.username = String(body.username).trim();
  if (body.fromAddresses !== undefined) {
    // Task 30, item 4 — multiple From addresses (rotated at queue-build time).
    const fromAddresses = Array.isArray(body.fromAddresses)
      ? body.fromAddresses.map((a) => String(a ?? "").trim()).filter((a) => a.length > 0)
      : [];
    // Empty list -> send as the SMTP username; never store "" elements.
    data.fromAddresses = fromAddresses;
  }
  // The port this save will leave behind — the new one when the form changed it,
  // otherwise the stored one. Needed by BOTH the secure/TLS derivation below and
  // the host guard (the operator's own-relay allowlist is host:PORT specific).
  const nextPort = body.port !== undefined ? Number(body.port) : existing.port;
  // Task 26, Piece 5a — `secure` is derived from the (possibly new) port, never a
  // checkbox: 465 => implicit TLS, anything else => STARTTLS. allowInsecure is the
  // explicit plaintext opt-out for the "None" mode and is stored independently. A
  // save that changes port/security always recomputes secure from the resolved port.
  if (body.port !== undefined || body.allowInsecure !== undefined) {
    data.secure = nextPort === 465;
  }
  if (body.allowInsecure !== undefined) data.allowInsecure = Boolean(body.allowInsecure);
  // TASK_134 (premium) — server-side boundary, same as test-connection: the
  // UI disables the picker for free tier, but never trust the client alone.
  if (body.sendRegion !== undefined) {
    const region = body.sendRegion && body.sendRegion.trim() ? body.sendRegion.trim() : null;
    if (region) {
      if (!(await canUseExitNodes(prisma, session.userId))) {
        return NextResponse.json({ error: "Regional send routing is a premium feature (or has been restricted)." }, { status: 403 });
      }
      if (!getExitNode(region)) {
        return NextResponse.json({ error: `Send region "${region}" is not available right now.` }, { status: 400 });
      }
    }
    data.sendRegion = region;
  }
  if (body.dailyLimit !== undefined) data.dailyLimit = Number(body.dailyLimit);
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.password !== undefined && String(body.password).length > 0) {
    const { ciphertext, iv, tag } = encryptSecret(String(body.password));
    data.encryptedPassword = ciphertext;
    data.passwordIv = iv;
    data.passwordTag = tag;
  }

  // Task 51 — if the host is being changed, reject loopback/private/link-local /
  // non-routable addresses at save time (same gate as CREATE and test-connection).
  if (data.host !== undefined && typeof data.host === "string") {
    try {
      await validatePublicSmtpHost(data.host, nextPort);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid SMTP host" },
        { status: 400 }
      );
    }
  }

  const mailbox = await prisma.mailbox.update({
    where: { id },
    data,
    select: MAILBOX_SAFE_SELECT,
  });

  return NextResponse.json(mailbox);
}

export async function DELETE(
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

  // A mailbox is a HISTORY-BEARING object, so a delete that would sever that
  // history is REFUSED with an explanation rather than cascaded. EmailQueueItem
  // .mailboxId references Mailbox with ON DELETE RESTRICT (verified in
  // pg_constraint: confdeltype = 'r'), because each queue row is the record of a
  // recipient this account actually sent to. Cascade-deleting those rows would
  // destroy campaign history, and clearing EmailCampaign.mailboxIds first would
  // let a running campaign keep sending on a mailbox that no longer exists —
  // that is worse than the delete failing. Previously this was a bare delete, so
  // any mailbox with >=1 queue row threw Prisma P2003 and the route returned an
  // opaque 500 the UI then swallowed; now it says what actually happened.
  try {
    await prisma.mailbox.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      // "roughly how much": total queue rows plus the number of campaigns they
      // belong to, which is what tells the owner whether this is one stale test
      // or real send history.
      const [count, campaignRows] = await Promise.all([
        prisma.emailQueueItem.count({ where: { mailboxId: id } }),
        prisma.emailQueueItem.findMany({
          where: { mailboxId: id },
          select: { campaignId: true },
          distinct: ["campaignId"],
        }),
      ]);
      return NextResponse.json(
        {
          error: `This mailbox has already been used to send (${count} queued message(s) across ${campaignRows.length} campaign(s)), so it can't be deleted without losing that history. Use Pause to stop it being used for new sends.`,
        },
        { status: 409 }
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}