import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { runTestSend } from "@/lib/deliverability";
import { ensureSeedMailbox } from "@/lib/seed-mailbox";

// POST: send one test message to a platform-owned seed mailbox and verify it
// actually arrives via IMAP, recording a DeliverabilityCheck. This is the
// manual-confirm mode gate — it returns delivered/failed without ever touching the
// campaign's queued items. The campaign stays at "pending_test_confirm" until the
// user explicitly confirms via POST /api/campaigns/[id]/confirm-test.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    include: {
      variants: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (campaign.status === "sending" || campaign.status === "done") {
    return NextResponse.json(
      { error: "Campaign has already started or finished sending" },
      { status: 409 }
    );
  }

  const variant = campaign.variants[0];
  if (!variant) {
    return NextResponse.json({ error: "Campaign has no variant to test with" }, { status: 400 });
  }

  // A campaign rotates recipients across EVERY mailbox in mailboxIds — testing
  // only one (e.g. the oldest) would let a bad mailbox #2/#3 slip through the
  // gate and silently fail recipients rotated onto it during the real send.
  const mailboxes = await prisma.mailbox.findMany({
    where: { id: { in: campaign.mailboxIds }, userId: session.userId, active: true },
    orderBy: { createdAt: "asc" },
  });
  if (mailboxes.length === 0) {
    return NextResponse.json({ error: "No active sending mailbox on this campaign" }, { status: 400 });
  }

  const seed = await ensureSeedMailbox() ?? await prisma.seedMailbox.findFirst({ where: { active: true } });
  if (!seed) {
    return NextResponse.json(
      { error: "No platform seed mailbox is configured — a real one is required to prove delivery" },
      { status: 400 }
    );
  }

  // Run all mailboxes' tests concurrently (each already waits ~20s internally
  // for the IMAP poll) rather than serially, which would multiply the wait by
  // the mailbox count.
  const results = await Promise.all(
    mailboxes.map((mailbox) => runTestSend({ campaignId: campaign.id, mailbox, variant, seed })),
  );

  const failed = results.filter((r) => r.outcome !== "delivered");
  const outcome: "delivered" | "failed" = failed.length === 0 ? "delivered" : "failed";
  const error =
    failed.length > 0
      ? failed
          .map((r, i) => `${mailboxes[results.indexOf(r)]?.label ?? `mailbox ${i + 1}`}: ${r.error ?? "not delivered"}`)
          .join("; ")
      : undefined;

  // Write one summary row reflecting the whole gate's outcome — it's what the
  // dashboard's "latest check" (campaign.checks[0]) needs to represent, since
  // the gate is only truly passed when every rotated mailbox is verified.
  const summary = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: campaign.id,
      seedMailboxId: seed.id,
      status: outcome,
      messageId: null,
      error,
      checkedAt: new Date(),
    },
  });

  return NextResponse.json({ outcome, checkId: summary.id, error });
}