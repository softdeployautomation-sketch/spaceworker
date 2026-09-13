import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { runTestSend } from "@/lib/deliverability";
import { resolveSeedMailbox } from "@/lib/seed-mailbox";

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

  // Legacy pair campaigns have a CampaignVariant row; decoupled campaigns (item 4)
  // keep no rows, so synthesize a probe variant from the independent subject/body
  // lists (first entry of each) to test-send with.
  let variant: { subject: string; bodyHtml: string } | undefined = campaign.variants[0];
  if (!variant && campaign.subjects && campaign.subjects.length > 0) {
    variant = {
      subject: campaign.subjects[0],
      bodyHtml: campaign.bodies && campaign.bodies.length > 0 ? campaign.bodies[0] : "",
    };
  }
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

  // Human-assisted fallback: a campaign with testRecipientOverride set (either
  // chosen at creation, or after the automated seed-mailbox check failed) skips
  // the seed mailbox entirely — every test goes straight to that plain address,
  // and "delivered" there just means the SMTP send succeeded (see
  // lib/deliverability.ts's runTestSend for why: no IMAP account exists to poll,
  // so the human is the one confirming placement, not this route).
  const overrideRecipient = campaign.testRecipientOverride?.trim() || null;
  const seed = overrideRecipient ? null : await resolveSeedMailbox(session.userId);
  if (!overrideRecipient && !seed) {
    return NextResponse.json(
      { error: "No seed/test mailbox is configured — a real one is required to prove delivery" },
      { status: 400 }
    );
  }

  // Run all mailboxes' tests concurrently (each already waits ~20s internally
  // for the IMAP poll — skipped entirely in override mode) rather than serially,
  // which would multiply the wait by the mailbox count.
  const results = await Promise.all(
    mailboxes.map((mailbox) =>
      overrideRecipient
        ? runTestSend({ campaignId: campaign.id, mailbox, variant, overrideRecipient })
        : runTestSend({ campaignId: campaign.id, mailbox, variant, seed: seed! }),
    ),
  );

  const failed = results.filter((r) => r.outcome !== "delivered");
  const outcome: "delivered" | "failed" = failed.length === 0 ? "delivered" : "failed";
  const error =
    failed.length > 0
      ? failed
          .map((r, i) => `${mailboxes[results.indexOf(r)]?.label ?? `mailbox ${i + 1}`}: ${r.error ?? "not delivered"}`)
          .join("; ")
      : undefined;

  // Task 29, item 6 — aggregate where the tests landed. "spam" if ANY test hit the
  // spam folder (worst case is what the run-detail UI must not hide); "unknown" if
  // none could be verified; else "inbox".
  const landedIn =
    results.some((r) => r.landedIn === "spam")
      ? "spam"
      : results.some((r) => r.landedIn === "unknown")
        ? "unknown"
        : "inbox";

  // Write one summary row reflecting the whole gate's outcome — it's what the
  // dashboard's "latest check" (campaign.checks[0]) needs to represent, since
  // the gate is only truly passed when every rotated mailbox is verified.
  const summary = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: campaign.id,
      seedMailboxId: seed?.id ?? null,
      overrideRecipient,
      status: outcome,
      landedIn,
      messageId: null,
      error,
      checkedAt: new Date(),
    },
  });

  return NextResponse.json({ outcome, checkId: summary.id, error });
}