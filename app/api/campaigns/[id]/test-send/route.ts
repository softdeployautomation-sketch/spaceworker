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
//
// Task 32 — optional live-draft override. The default tests the campaign's STORED
// content (subjects[0]/bodies[0], or the first CampaignVariant for legacy). A body
// of { "subject", "bodyHtml", "from?" } instead tests that arbitrary DRAFT content
// as a live probe WITHOUT persisting anything — nothing is written back to the
// campaign, so a user (or later an agent driving the same REST surface) can try a
// tweak before ever deciding to promote it. `from` overrides the From address the
// probe is sent as (falls back to the normal mailbox.fromAddresses rotation when
// omitted).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // Task 32 — parse the optional draft override up front (ignored when absent).
  let reqBody: { subject?: unknown; bodyHtml?: unknown; from?: unknown } = {};
  try {
    reqBody = await req.json();
  } catch {
    reqBody = {};
  }
  const draftSubject = typeof reqBody.subject === "string" ? reqBody.subject.trim() : undefined;
  const draftBodyHtml = typeof reqBody.bodyHtml === "string" ? reqBody.bodyHtml : undefined;
  // Optional Task 30 item 4 override — send the probe as a specific From address.
  const draftFrom = typeof reqBody.from === "string" ? reqBody.from.trim() : undefined;

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

  // Task 32 — a draft override means "test THIS content, not the stored one":
  // skip the stored-content resolution entirely and build the probe variant from
  // the draft values. Nothing is persisted here — it's a live probe only.
  let variant: { subject: string; bodyHtml: string } | undefined;
  if (draftSubject !== undefined || draftBodyHtml !== undefined) {
    variant = { subject: draftSubject ?? "", bodyHtml: draftBodyHtml ?? "" };
    if (!variant.subject && !variant.bodyHtml) {
      return NextResponse.json({ error: "Edited content is empty — provide a subject and/or body" }, { status: 400 });
    }
  } else {
    // Legacy pair campaigns have a CampaignVariant row; decoupled campaigns (item 4)
    // keep no rows, so synthesize a probe variant from the independent subject/body
    // lists (first entry of each) to test-send with.
    variant = campaign.variants[0];
    if (!variant && campaign.subjects && campaign.subjects.length > 0) {
      variant = {
        subject: campaign.subjects[0],
        bodyHtml: campaign.bodies && campaign.bodies.length > 0 ? campaign.bodies[0] : "",
      };
    }
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

  // Override mode: a human is about to look at their own inbox, so send each
  // mailbox's test SEQUENTIALLY with a short human-paced gap between them —
  // confirmed live this matters: 4 configured mailboxes fired via Promise.all
  // landed as 4 identical-looking test emails in the same second, reading as an
  // obvious blast rather than what the real send (which already staggers via
  // random jitter in the mail-queue drain) actually does. There's no 2-minute
  // IMAP poll in this mode to make serializing expensive, so there's no
  // downside to pacing it the same way.
  //
  // Seed-mailbox mode keeps running all mailboxes CONCURRENTLY — each one
  // already waits up to 2 minutes for its own IMAP poll, so serializing here
  // would multiply that wait by the mailbox count for no benefit (nothing
  // human-visible is watching these arrive in real time).
  const results: Awaited<ReturnType<typeof runTestSend>>[] = [];
  if (overrideRecipient) {
    for (const mailbox of mailboxes) {
      if (results.length > 0) await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 4_000));
      results.push(await runTestSend({ campaignId: campaign.id, mailbox, variant, overrideRecipient, ...(draftFrom ? { from: draftFrom } : {}) }));
    }
  } else {
    results.push(
      ...(await Promise.all(
        mailboxes.map((mailbox) => runTestSend({ campaignId: campaign.id, mailbox, variant, seed: seed!, ...(draftFrom ? { from: draftFrom } : {}) })),
      )),
    );
  }

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