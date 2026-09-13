import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 35 — a deliberately LIGHTWEIGHT live view of a campaign's most recent send
// attempts, for the always-visible sending ticker and the live-updating activity
// modal. It is NOT the full campaign payload (which drags every queued item's
// subject/body with it — Task 34 flagged that over-fetch cost, and the ticker
// polls this every few seconds while a campaign is sending, so it has to stay
// small). Returns only: the latest N send attempts (`{ id, toEmail, status,
// sentAt }`), plus compact aggregate counts and a per-mailbox sent/failed
// breakdown so the ticker AND the activity modal share a single poll instead of
// each fetching separately.
//
// Ordering note: EmailQueueItem has no `updatedAt`, and a failed send leaves
// `sentAt` null (only `createdAt` is guaranteed), so an attempt's "when it
// happened" is `sentAt` for a success and `createdAt` for a failure. We fetch a
// small recent window and sort in JS by that effective timestamp so failures
// interleave chronologically with successes instead of sinking to the bottom of
// a naive sentAt-ordered SQL sort (which would put the null-sentAt failures
// first/last depending on DB NULL ordering).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 5;

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    select: { mailboxIds: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Resolve mailbox ids → labels once so the breakdown keys match the modal's
  // existing `mc.label ?? mailboxId` convention.
  const mailboxes = await prisma.mailbox.findMany({
    where: { id: { in: campaign.mailboxIds } },
    select: { id: true, label: true, username: true },
  });
  const labelById = new Map(mailboxes.map((m) => [m.id, m.label || m.username]));

  const [recentRows, statusCounts, mailboxCounts] = await Promise.all([
    // A small window of the newest attempts by creation, re-sorted by effective
    // send time in JS below.
    prisma.emailQueueItem.findMany({
      where: { campaignId: id, status: { in: ["sent", "failed"] } },
      orderBy: { createdAt: "desc" },
      take: Math.max(limit * 4, 20),
      select: { id: true, toEmail: true, status: true, sentAt: true, createdAt: true, mailboxId: true },
    }),
    prisma.emailQueueItem.groupBy({
      by: ["status"],
      where: { campaignId: id },
      _count: { _all: true },
    }),
    prisma.emailQueueItem.groupBy({
      by: ["mailboxId", "status"],
      where: { campaignId: id, status: { in: ["sent", "failed"] } },
      _count: { _all: true },
    }),
  ]);

  const counts = { recipients: 0, sent: 0, queued: 0, failed: 0 };
  for (const row of statusCounts) {
    const n = row._count._all;
    if (row.status === "sent") counts.sent = n;
    else if (row.status === "failed") counts.failed = n;
    else if (row.status === "queued" || row.status === "pending") counts.queued += n;
    counts.recipients += n;
  }

  const byMailbox: Record<string, { sent: number; failed: number }> = {};
  for (const row of mailboxCounts) {
    const label = labelById.get(row.mailboxId) ?? row.mailboxId;
    const slot = (byMailbox[label] ??= { sent: 0, failed: 0 });
    if (row.status === "sent") slot.sent += row._count._all;
    else if (row.status === "failed") slot.failed += row._count._all;
  }

  // Sort by effective send time (sentAt for successes, createdAt for failures),
  // newest first, then trim to the requested window.
  const items = recentRows
    .slice()
    .sort(
      (a, b) =>
        (b.sentAt?.getTime() ?? b.createdAt.getTime()) -
        (a.sentAt?.getTime() ?? a.createdAt.getTime())
    )
    .slice(0, limit)
    .map((i) => ({
      id: i.id,
      toEmail: i.toEmail,
      status: i.status,
      sentAt: i.sentAt?.toISOString() ?? null,
    }));

  return NextResponse.json({ items, counts, byMailbox });
}