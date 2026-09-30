import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import { validatePublicSmtpHost } from "@/lib/smtp-host-guard";
import { getExitNode } from "@/lib/exit-nodes";
import { canUseExitNodes } from "@/lib/premium";
import type { Prisma } from "@prisma/client"; // type-only: the DELETE handler's FK
                                              // refusal check now lives in lib/prisma-fk-error
import { isForeignKeyRefusal } from "@/lib/prisma-fk-error";

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
  req: Request,
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

  // Deleting a mailbox must actually delete it — that is the entire point of the
  // button — but the queue rows it leaves behind are the ONLY record of what this
  // account sent (there is no separate SendLog table: toEmail / status / sentAt /
  // error live on EmailQueueItem itself), so the two cases are NOT the same and
  // must not share one answer:
  //
  //   * rows that were DELIVERED (`sent`) are history. Deleting the mailbox
  //     destroys the only copy, so that needs the owner's explicit consent.
  //   * rows that never left (`queued`) or were rejected by the provider
  //     (`failed`) are not history — they are unsent work and provider errors.
  //     Refusing to delete a mailbox because it has 71 never-sent rows for a
  //     stopped campaign is friction with nothing behind it. That was the actual
  //     complaint: a test mailbox with **0 delivered messages** could not be
  //     removed, and its 50 rows were all 550-spam rejects.
  //
  // A campaign that is `sending` right now is also a blocker: its recipients are
  // being drained through this mailbox as we speak.
  //
  // `EmailQueueItem.mailboxId` is ON DELETE RESTRICT, so the rows MUST go in the
  // same transaction as the mailbox — hence the explicit deleteMany below rather
  // than relying on the FK to cascade.
  const force = new URL(req.url).searchParams.get("force") === "1";

  const [sent, queued, failed, campaigns] = await Promise.all([
    prisma.emailQueueItem.count({ where: { mailboxId: id, status: "sent" } }),
    prisma.emailQueueItem.count({ where: { mailboxId: id, status: "queued" } }),
    prisma.emailQueueItem.count({
      where: { mailboxId: id, status: { notIn: ["sent", "queued"] } },
    }),
    prisma.emailCampaign.findMany({
      where: { userId: session.userId, mailboxIds: { has: id } },
      select: { id: true, name: true, status: true, mailboxIds: true },
    }),
  ]);
  const total = sent + queued + failed;
  const sending = campaigns.filter((c) => c.status === "sending");

  if (!force && (sent > 0 || sending.length > 0)) {
    const breakdown = [
      sent > 0 ? `${sent} delivered` : null,
      queued > 0 ? `${queued} not yet sent` : null,
      failed > 0 ? `${failed} failed` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const sendingNote = sending.length
      ? ` It is sending for ${sending.map((c) => `"${c.name}"`).join(", ")} right now — stop that campaign first, or confirm to remove the mailbox anyway.`
      : "";
    return NextResponse.json(
      {
        error: `"${mailbox.label}" has sent mail (${breakdown}). Those ${total} message record(s) are the only copy, and deleting the mailbox deletes them.${sendingNote}`,
        requiresConfirmation: true,
        blockers: { sent, queued, failed, total },
      },
      { status: 409 }
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const removed = await tx.emailQueueItem.deleteMany({ where: { mailboxId: id } });
      // Strip the id out of every campaign that rotates through this mailbox.
      // buildQueueItemRows assigns `mailboxIds[i % len]` from the campaign's own
      // array, so a stale id left behind would be handed to a recipient on the
      // next resume and fail the FK on insert. A campaign that ends up with []
      // simply has nothing to send on, which is the honest outcome of deleting
      // its only mailbox.
      for (const c of campaigns) {
        await tx.emailCampaign.update({
          where: { id: c.id },
          data: { mailboxIds: c.mailboxIds.filter((m) => m !== id) },
        });
      }
      await tx.mailbox.delete({ where: { id } });
      return { removed: removed.count, campaigns: campaigns.length };
    });

    return NextResponse.json({
      ok: true,
      deletedQueueItems: result.removed,
      updatedCampaigns: result.campaigns,
    });
  } catch (err) {
    // Safety net only — every dependent we know of is handled above, so reaching
    // here means a dependent nobody anticipated. Report it rather than 500.
    //
    // NOTE: this must go through isForeignKeyRefusal(), NOT an `err.code === "P2003"`
    // test. PostgreSQL 18 (what production runs) raises SQLSTATE 23001 for RESTRICT,
    // which Prisma does not map to any P-code — so a P2003 check is dead code there
    // and this route kept returning 500 even after the first fix. PostgreSQL 16 (the
    // dev machine) raises 23503, which IS mapped to P2003 — which is why every local
    // test passed. See lib/prisma-fk-error.ts for the measurements.
    if (isForeignKeyRefusal(err)) {
      return NextResponse.json(
        {
          error:
            "This mailbox is still referenced by records that depend on it, so it can't be deleted yet.",
        },
        { status: 409 }
      );
    }
    throw err;
  }
}