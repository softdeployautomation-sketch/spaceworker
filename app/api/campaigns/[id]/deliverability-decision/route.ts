import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Resolves a campaign that's awaiting a human deliverability decision — either
// the batch gate's mid-send pause (status "paused_deliverability", set by the
// mail-queue drain) OR the very first test-send, when the automated check
// failed/couldn't verify placement (status "pending_test_confirm"). Same three
// actions, meaning depends on which state the campaign is actually in:
//   "continue"       — paused_deliverability: trust the operator, resume sending.
//                       pending_test_confirm: the human manually checked their own
//                       inbox and it's actually fine (our automated check missed
//                       it, or was inconclusive) — records a manual-override
//                       DeliverabilityCheck ("delivered"/"inbox") for the audit
//                       trail, then unlocks straight to "sending" (skips a
//                       separate confirm-test call since the human already made
//                       the call this endpoint exists to capture).
//   "switch_subject" — rotate to the next independent subject (decoupled
//                      campaigns; no-op rotation for legacy pair campaigns).
//                      paused_deliverability: rotates AND resumes sending.
//                      pending_test_confirm: rotates only — status STAYS
//                      pending_test_confirm, since nothing has been confirmed to
//                      send yet; the frontend re-runs the test-send right after.
//   "stop"           — stop the campaign (terminal). Remaining queued items stay
//                      queued but the campaign never re-enters "sending". Allowed
//                      from either state (halting is always safe).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({ where: { id, userId: session.userId } });
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = body.action === "continue" || body.action === "switch_subject" || body.action === "stop"
    ? body.action
    : "continue";

  const fromInitialGate = campaign.status === "pending_test_confirm";
  const fromBatchPause = campaign.status === "paused_deliverability";

  // Guard against bypassing the whole deliverability gate: this route only ever
  // resolves a real pending decision (the initial gate or a batch-gate pause).
  // Without this check, calling it on a campaign already "sending"/"done"/etc.
  // would be a no-op at best or a confusing state jump at worst. "stop" is
  // allowed from any non-terminal state since halting is always safe.
  if (!fromInitialGate && !fromBatchPause && action !== "stop") {
    return NextResponse.json(
      { error: `Campaign is not awaiting a deliverability decision (status: ${campaign.status})` },
      { status: 409 },
    );
  }

  if (action === "stop") {
    await prisma.emailCampaign.update({ where: { id }, data: { status: "stopped" } });
    return NextResponse.json({ ok: true, status: "stopped" });
  }

  if (action === "switch_subject") {
    const rotatedSubjects = Array.isArray(campaign.subjects) && campaign.subjects.length > 1
      ? [...campaign.subjects.slice(1), campaign.subjects[0]]
      : undefined;
    // From the initial gate: rotate only, stay put — nothing has been confirmed
    // to send yet, so there's no "resume" to do. The frontend immediately
    // re-runs the test-send against the new subject.
    if (fromInitialGate) {
      await prisma.emailCampaign.update({
        where: { id },
        data: rotatedSubjects ? { subjects: rotatedSubjects } : {},
      });
      return NextResponse.json({ ok: true, status: campaign.status });
    }
    // From a batch pause: rotate AND resume — this is the existing behavior.
    await prisma.emailCampaign.update({
      where: { id },
      data: { ...(rotatedSubjects ? { subjects: rotatedSubjects } : {}), status: "sending" },
    });
    return NextResponse.json({ ok: true, status: "sending" });
  }

  // "continue"
  if (fromInitialGate) {
    // The human manually verified delivery (checked their own inbox) despite the
    // automated check failing or timing out — record that as an explicit,
    // auditable override rather than silently trusting a stale "failed" row, then
    // unlock straight to sending (equivalent to what confirm-test would do once
    // a "delivered" check exists, done here in one step since the human's click
    // IS that confirmation).
    await prisma.deliverabilityCheck.create({
      data: {
        campaignId: id,
        seedMailboxId: null,
        status: "delivered",
        landedIn: "inbox",
        error: "Manually confirmed by the user — the automated check did not verify delivery in time.",
        checkedAt: new Date(),
      },
    });
    await prisma.emailCampaign.update({ where: { id }, data: { status: "sending" } });
    return NextResponse.json({ ok: true, status: "sending" });
  }

  // From a batch pause — resume from where the drain paused.
  await prisma.emailCampaign.update({ where: { id }, data: { status: "sending" } });
  return NextResponse.json({ ok: true, status: "sending" });
}