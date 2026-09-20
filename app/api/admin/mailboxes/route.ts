import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/admin/mailboxes — Task 50: read-only admin visibility into every
// connected SMTP mailbox across all users. This is the single highest
// real-world-abuse-potential feature in the product (arbitrary SMTP accounts
// send mass email) and previously had NO admin surface at all — the admin
// couldn't see a mailbox connect, send, or fail. READ-ONLY by design: this is
// an accountability surface, not a management one (pausing/disabling a
// customer's mailbox is deliberately a separate, bigger task).
// NEVER returns encryptedPassword / passwordIv / passwordTag.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const mailboxes = await db.mailbox.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { email: true } },
      // One live rollup per mailbox for the "how much is it actually sending"
      // column, so the admin sees abuse pressure without a manual COUNT.
      _count: { select: { queueItems: true } },
    },
  });

  return NextResponse.json({
    mailboxes: mailboxes.map((m) => ({
      id: m.id,
      label: m.label,
      host: m.host,
      port: m.port,
      username: m.username,
      fromAddresses: m.fromAddresses,
      secure: m.secure,
      active: m.active,
      dailyLimit: m.dailyLimit,
      sentToday: m.sentToday,
      sentTodayDate: m.sentTodayDate,
      lastTestedAt: m.lastTestedAt?.toISOString() ?? null,
      lastTestOk: m.lastTestOk,
      queuedItems: m._count.queueItems,
      userEmail: m.user.email,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}