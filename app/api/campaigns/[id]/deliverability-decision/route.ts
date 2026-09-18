import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import {
  applyPinAndContinue,
  applySwitchSubject,
  DeliverabilityError,
} from "@/lib/deliverability";
import { finalizeMailerStretch, mayEnterSending } from "@/lib/trial";

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
//                      campaigns). From a batch pause: rotates AND moves the
//                      campaign back into the initial-gate "pending_test_confirm"
//                      shape so resuming requires a fresh test-send + human
//                      confirm of the NEW content (Task 36) — never a bare
//                      flip to "sending" without re-verification. From the
//                      initial gate: rotates only — status STAYS
//                      pending_test_confirm, since nothing has been confirmed to
//                      send yet; the frontend re-runs the test-send right after.
//                      Task 36 — a legacy (non-decoupled) or single-subject
//                      campaign has nothing to rotate to, so this returns a 400
//                      (redirecting to Task 32's "Manually edit and test") rather
//                      than silently resuming with the content that just failed.
//   "add_edit_and_continue" — Task 32: promote a manually-authored draft (subject/
//                      bodyHtml fields) that a real test-send already judged good
//                      into the campaign's rotation, as the PREFERRED entry. Front-
//                      inserted at index 0 of subjects/bodies (not appended), so
//                      the very next test-send and the very next batch pick it up
//                      first (rotation is i % length — no weighting scheme needed).
//                      For a legacy pair campaign with empty subjects/bodies, this
//                      naturally upgrades it into the decoupled model, seeding each
//                      array with the original CampaignVariant's content as the
//                      second entry so nothing already in flight is dropped. Records
//                      a manual-override DeliverabilityCheck like "continue" does,
//                      then resumes/ unlocks to "sending" from either state.
//   "pin_and_continue" — Task 33: a TEMPORARY pinned override. { subject, bodyHtml,
//                      from?, pinCount? } locks the campaign onto one proven-good
//                      combination for exactly `pinCount` sends (default batchSize,
//                      clamped [1,1000]), suspending normal rotation for that window
//                      ("that exact run gets sent to the next N contacts... canceling
//                      the normal flow of changing subject after 10 sent"). Unlike
//                      add_edit_and_continue it doesn't touch the rotation yet — it
//                      sets EmailCampaign.pinnedOverride, which the drain honors and
//                      decrements per send, then clears (promoting the combo into the
//                      rotation on a clean finish, per TASK_33 §2). Requires the same
//                      explicit human click as every action here — never auto-applied.
//   "stop"           — stop the campaign (terminal). Remaining queued items stay
//                      queued but the campaign never re-enters "sending". Allowed
//                      from either state (halting is always safe).
// `DeliverabilityError` → `NextResponse` mapping for the two branches that now
// delegate to the shared lib/deliverability.ts implementations.
function decisionError(err: unknown): NextResponse | null {
  if (err instanceof DeliverabilityError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

// Tier 1 trial — every branch below that resolves straight to "sending" is an
// entry point (same as confirm-test), so it needs the same daily-allowance
// gate + sendingStartedAt marker. Shared here since three branches do this.
async function tryEnterSending(
  campaignId: string,
  userId: string,
  extraData: Record<string, unknown>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const owner = await tx.user.findUnique({ where: { id: userId }, select: { tier: true } });
    const allowed = await mayEnterSending(tx, {
      userId,
      tier: owner?.tier ?? 0,
      excludeCampaignId: campaignId,
    });
    if (!allowed) return false;
    await tx.emailCampaign.update({
      where: { id: campaignId },
      data: { ...extraData, status: "sending", sendingStartedAt: new Date() },
    });
    return true;
  });
}

function trialCapResponse(): NextResponse {
  return NextResponse.json(
    { error: "Daily send-time limit reached for your plan. Try again after UTC midnight, or upgrade to Premium." },
    { status: 429 },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { action?: string; subject?: unknown; bodyHtml?: unknown; from?: unknown; pinCount?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = body.action === "continue" || body.action === "switch_subject" || body.action === "stop" || body.action === "add_edit_and_continue" || body.action === "pin_and_continue"
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
    // Tier 1 trial — "stop" is allowed even while actively "sending" (halting is
    // always safe), so finalize any in-flight mailer stretch in the SAME
    // transaction as the status flip. No-op when sendingStartedAt is already
    // null (e.g. stopping from a pause, whose stretch was already finalized).
    await prisma.$transaction(async (tx) => {
      await finalizeMailerStretch(tx, {
        id: campaign.id,
        userId: campaign.userId,
        sendingStartedAt: campaign.sendingStartedAt,
      });
      await tx.emailCampaign.update({ where: { id }, data: { status: "stopped" } });
    });
    return NextResponse.json({ ok: true, status: "stopped" });
  }

  if (action === "switch_subject") {
    // Task 36 — never a silent no-op. Rotating is only meaningful when the
    // campaign actually HAS an independent subject to rotate to (legacy / single-
    // subject campaigns throw a 400 redirecting to Task 32's "Manually edit and
    // test"). The shared implementation lives in lib/deliverability.ts so the AI
    // agent's pending-action executor calls the exact same code as this route.
    try {
      const res = await applySwitchSubject(id, { userId: session.userId, fromInitialGate });
      return NextResponse.json(res);
    } catch (err) {
      const r = decisionError(err);
      if (r) return r;
      throw err;
    }
  }

  // \"pin_and_continue\" — Task 33: lock the campaign onto one particular
  // proven-good combination for a WINDOW of upcoming sends (suspending normal
  // per-batch rotation for that stretch), not a permanent rotation change like
  // add_edit_and_continue. This is exactly the owner's ask: \"that exact run gets
  // sent to the next N contacts... canceling the normal flow of changing subject
  // after 10 sent.\" Requires the SAME explicit human-approval click as every
  // other action on this route (which is per-whoever's-calling real here — this
  // endpoint is the decision point); it is never auto-applied, even when the
  // future agent is the one proposing it. pinCount defaults to the campaign's
  // own batchSize (\"the next batch\") and is clamped to [1, 1000] like every
  // other numeric knob in this app.
  if (action === "pin_and_continue") {
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    // bodyHtml may legitimately be "" (a pinned empty-body diagnostic that came
    // back clean) — only the subject is required to pin.
    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml : "";
    const fromAddress = typeof body.from === "string" ? body.from.trim() : "";
    const numPinCount = Number(body.pinCount ?? campaign.batchSize ?? 50);
    const pinCount = Number.isFinite(numPinCount) ? numPinCount : campaign.batchSize ?? 50;

    // Task 33 — TEMPORARY pinned override, extracted to lib/deliverability.ts so
    // the AI agent's executor and this human route run the identical mutation.
    try {
      const res = await applyPinAndContinue(id, {
        userId: session.userId,
        subject,
        bodyHtml,
        fromAddress,
        pinCount,
      });
      return NextResponse.json(res);
    } catch (err) {
      const r = decisionError(err);
      if (r) return r;
      throw err;
    }
  }

  // "add_edit_and_continue" — Task 32: promote a human/agent-authored draft that a
  // real test-send judged good by eye into the campaign's rotation as the PREFERRED
  // entry. Front-insert at index 0 (rotation is i % length, so front-insertion is
  // what makes it "used preferentially" for free). For a legacy pair campaign this
  // also upgrades it into the decoupled model, seeding the arrays with the original
  // variant's content as the second entry so nothing already in flight is dropped.
  if (action === "add_edit_and_continue") {
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.trim() : "";
    if (!subject || !bodyHtml) {
      return NextResponse.json(
        { error: "Provide both an edited subject and body to promote" },
        { status: 400 }
      );
    }
    const legacy = campaign.variants[0];
    const hasDecoupled = Array.isArray(campaign.subjects) && campaign.subjects.length > 0;
    // Seed from the existing subjects/bodies for a decoupled campaign, or from the
    // legacy variant for a pair campaign being upgraded — either way the new edit
    // lands at index 0 with everything already present following it.
    const baseSubjects = hasDecoupled
      ? [...campaign.subjects]
      : legacy && legacy.subject
        ? [legacy.subject]
        : [];
    const baseBodies = hasDecoupled
      ? [...(Array.isArray(campaign.bodies) ? campaign.bodies : [])]
      : legacy && legacy.bodyHtml
        ? [legacy.bodyHtml]
        : [];
    // Front-insert unless the edit is already what sits at index 0 (no-op duplicate).
    const subjects = baseSubjects[0] === subject
      ? baseSubjects
      : [subject, ...baseSubjects.filter((s) => s !== "")];
    const bodies = baseBodies[0] === bodyHtml
      ? baseBodies
      : [bodyHtml, ...baseBodies.filter((b) => b !== "")];

    // This WAS a human-verified test (just with edited content) — record it in the
    // audit trail the same way the "continue" branch does, explicit that it was an
    // edited-and-approved variant.
    await prisma.deliverabilityCheck.create({
      data: {
        campaignId: id,
        seedMailboxId: null,
        status: "delivered",
        landedIn: "inbox",
        error: "Manually edited variant approved by the user — added to the front of the rotation.",
        checkedAt: new Date(),
      },
    });
    // Both states resolve to "sending" here: fromInitialGate unlocks straight to
    // sending; fromBatchPause resumes to sending — same as "continue".
    const entered = await tryEnterSending(id, session.userId, { subjects, bodies });
    if (!entered) return trialCapResponse();
    return NextResponse.json({ ok: true, status: "sending", subjects, bodies });
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
    const entered = await tryEnterSending(id, session.userId, {});
    if (!entered) return trialCapResponse();
    return NextResponse.json({ ok: true, status: "sending" });
  }

  // From a batch pause — resume from where the drain paused.
  const entered = await tryEnterSending(id, session.userId, {});
  if (!entered) return trialCapResponse();
  return NextResponse.json({ ok: true, status: "sending" });
}