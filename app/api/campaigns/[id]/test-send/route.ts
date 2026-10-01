import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { runTestSend } from "@/lib/deliverability";
import { planTestSendRecipients, type PlannedRecipient } from "@/lib/test-send-recipients";
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
  let reqBody: {
    subject?: unknown;
    bodyHtml?: unknown;
    from?: unknown;
    // TASK_150 T5 — `to` is deliberately `unknown`: it may be one address (as
    // before) or an array of them, and a non-string/non-array value must be
    // reported rather than silently ignored.
    to?: unknown;
  } = {};
  try {
    reqBody = await req.json();
  } catch {
    reqBody = {};
  }
  const draftSubject = typeof reqBody.subject === "string" ? reqBody.subject.trim() : undefined;
  const draftBodyHtml = typeof reqBody.bodyHtml === "string" ? reqBody.bodyHtml : undefined;
  // Optional Task 30 item 4 override — send the probe as a specific From address.
  // An explicitly-passed `from` wins (an explicit "" means "no override for this
  // one test"). When the caller passes none at all, the campaign's stored
  // test-only From (testFromOverride, set in the test-setup panel) is applied
  // below once the campaign is loaded — that's what makes "test as this From"
  // cover every test, not just the calls that remember to send it.
  let draftFrom = typeof reqBody.from === "string" ? reqBody.from.trim() : undefined;
  // 2026-09-28 — one-shot test recipient: "send THIS test to this address"
  // without touching the campaign's stored test target. It's how the test-setup
  // panel switches seats between test sends (Gmail this time, Outlook next) in
  // one round-trip, and it is deliberately never persisted here.
  //
  // TASK_150 T5 — it may now be MANY addresses (a string, as before, or an array),
  // and it may be omitted entirely in favour of the campaign's persisted
  // multi-selection. Which addresses a request resolves to, and in what
  // precedence, is decided by lib/test-send-recipients.ts — it needs the loaded
  // campaign row, so that resolution happens below rather than here.

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    include: {
      variants: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Now that the campaign is loaded, apply its stored test-only From when the
  // caller didn't pass one — see the note on `draftFrom` above.
  if (typeof reqBody.from !== "string") {
    draftFrom = campaign.testFromOverride?.trim() || undefined;
  }
  if (campaign.status === "sending" || campaign.status === "done") {
    return NextResponse.json(
      { error: "Campaign has already started or finished sending" },
      { status: 409 }
    );
  }

  // TASK_150 T5 — resolve WHICH addresses this test goes to (all of the shortlist,
  // a ticked subset, or the single active one). Precedence and the
  // "one bad address must not stop the others" rule live in the pure module so
  // they are unit-tested; an error here is a whole-request rejection (nothing
  // sent), whereas a malformed address *inside* a list is a per-address failure.
  const plan = planTestSendRecipients({
    to: reqBody.to,
    selection: campaign.testRecipientSelection,
    active: campaign.testRecipientOverride,
  });
  if (plan.mode === "error") {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }
  const overrideRecipients = plan.mode === "override" ? plan.recipients : null;

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
  // 2026-09-28 — a one-shot `to` from the caller takes precedence over the
  // stored target for this single request (switching test seats mid-flow without
  // a second round-trip); it changes nothing about the campaign. Note that
  // either way this is the OVERRIDE path, so there is no IMAP poll and the
  // outcome is "SMTP accepted it", not "it landed in the inbox" — exactly as
  // before, the human is the one who judges placement.
  // TASK_150 T5 — the stored side may now be a SET of addresses (all or a ticked
  // subset of the shortlist), resolved above by planTestSendRecipients().
  const seed = overrideRecipients ? null : await resolveSeedMailbox(session.userId);
  if (!overrideRecipients && !seed) {
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
  //
  // TASK_150 T5 — which MAILBOX each address goes out from:
  //   * ONE address (the shape that existed before this): from EVERY active
  //     mailbox, unchanged, so a bad mailbox #2/#3 cannot slip through the gate.
  //   * SEVERAL addresses: one send per address, with the campaign's mailboxes
  //     rotating round-robin across them. Sending N addresses from all M mailboxes
  //     would land N*M copies of the same message in the inboxes the owner is
  //     watching — the blast this comment warns about — while round-robin still
  //     exercises the whole rotation the real send will use.
  const targets: { mailbox: (typeof mailboxes)[number]; recipient: PlannedRecipient }[] = [];
  if (overrideRecipients) {
    if (overrideRecipients.length === 1) {
      for (const mailbox of mailboxes) targets.push({ mailbox, recipient: overrideRecipients[0] });
    } else {
      overrideRecipients.forEach((recipient, i) => {
        targets.push({ mailbox: mailboxes[i % mailboxes.length], recipient });
      });
    }
  }
  const multiRecipient = (overrideRecipients?.length ?? 0) > 1;

  const results: Awaited<ReturnType<typeof runTestSend>>[] = [];
  // The mailbox + address each entry in `results` came from, in the same order.
  // Replaces the old `mailboxes[results.indexOf(r)]` guesswork, and is what the
  // per-address report below is built from.
  const attemptInfo: { mailboxLabel: string; recipient: string | null }[] = [];
  if (overrideRecipients) {
    let sentAny = false;
    for (const target of targets) {
      // TASK_150 T5 — a malformed address is recorded as its OWN failure and then
      // skipped: never a 400 (the other addresses are still legitimate), and never
      // a reason to abandon the addresses queued after it.
      if (!target.recipient.valid) {
        results.push({
          outcome: "failed",
          checkId: "",
          landedIn: "unknown",
          error: `"${target.recipient.email}" is not a valid email address`,
        });
        attemptInfo.push({ mailboxLabel: target.mailbox.label, recipient: target.recipient.email });
        continue;
      }
      if (sentAny) await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 4_000));
      sentAny = true;
      // Always sequential, never Promise.all — see the blast comment above.
      results.push(
        await runTestSend({ campaignId: campaign.id, userId: campaign.userId, mailbox: target.mailbox, variant, overrideRecipient: target.recipient.email, bodyFormat: campaign.bodyFormat, ...(draftFrom ? { from: draftFrom } : {}) }),
      );
      attemptInfo.push({ mailboxLabel: target.mailbox.label, recipient: target.recipient.email });
    }
  } else {
    results.push(
      ...(await Promise.all(
        mailboxes.map((mailbox) => runTestSend({ campaignId: campaign.id, userId: campaign.userId, mailbox, variant, seed: seed!, bodyFormat: campaign.bodyFormat, ...(draftFrom ? { from: draftFrom } : {}) })),
      )),
    );
    for (const mailbox of mailboxes) attemptInfo.push({ mailboxLabel: mailbox.label, recipient: null });
  }

  const failed = results.filter((r) => r.outcome !== "delivered");
  const outcome: "delivered" | "failed" = failed.length === 0 ? "delivered" : "failed";
  const error =
    failed.length > 0
      ? failed
          .map((r, i) => {
            const info = attemptInfo[results.indexOf(r)];
            const label = info?.mailboxLabel ?? `mailbox ${i + 1}`;
            // With several addresses the failure text has to name the address —
            // otherwise one address's failure is unattributable in the summary.
            // With a single address the text is exactly what it was before.
            const who = multiRecipient && info?.recipient ? `${info.recipient} via ${label}` : label;
            return `${who}: ${r.error ?? "not delivered"}`;
          })
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

  // TASK_150 T5 — the per-address report. A recipient is "delivered" only when
  // EVERY attempt made for it succeeded, the same rule the summary row already
  // followed for the whole gate. runTestSend has already written one
  // DeliverabilityCheck per attempt (carrying that attempt's own
  // overrideRecipient), so this is a report over real rows, not a second store.
  const recipientOutcomes = (overrideRecipients ?? []).map((planned) => {
    const mine = attemptInfo
      .map((info, i) => ({ info, result: results[i] }))
      .filter((x) => x.info.recipient?.toLowerCase() === planned.email.toLowerCase());
    const failedMine = mine.filter((x) => x.result.outcome !== "delivered");
    return {
      email: planned.email,
      outcome: (mine.length > 0 && failedMine.length === 0 ? "delivered" : "failed") as
        | "delivered"
        | "failed",
      error: failedMine.length > 0 ? failedMine.map((x) => x.result.error ?? "not delivered").join("; ") : null,
      mailboxes: mine.map((x) => ({
        label: x.info.mailboxLabel,
        outcome: x.result.outcome,
        error: x.result.error ?? null,
      })),
    };
  });

  // With more than one address the per-address rows written by runTestSend ARE the
  // newest rows, and the gate (POST /api/campaigns/[id]/confirm-test) reads the
  // newest check by createdAt desc — so the summary row below must genuinely be
  // written after them, not merely "later in the code". A real gap keeps the
  // ordering from tying and handing the gate one address's status instead of the
  // whole run's.
  if (multiRecipient) await new Promise((r) => setTimeout(r, 50));

  // Write one summary row reflecting the whole gate's outcome — it's what the
  // dashboard's "latest check" (campaign.checks[0]) needs to represent, since
  // the gate is only truly passed when every rotated mailbox is verified.
  const summary = await prisma.deliverabilityCheck.create({
    data: {
      campaignId: campaign.id,
      seedMailboxId: seed?.id ?? null,
      // TASK_150 T5 — for a multi-address run the summary row keeps the FIRST
      // address (the primary target); each address's own outcome is already on its
      // own row written by runTestSend, and in the response's `recipients`.
      overrideRecipient: overrideRecipients?.[0]?.email ?? null,
      status: outcome,
      landedIn,
      messageId: null,
      error,
      checkedAt: new Date(),
    },
  });

  // Task 34 — return the FULL created DeliverabilityCheck (not just a handle) so
  // the frontend can prepend it to its checks list and re-render the top box
  // without re-fetching the whole campaign (which re-pulls every queued item).
  return NextResponse.json({
    outcome,
    checkId: summary.id,
    error,
    check: {
      id: summary.id,
      status: summary.status,
      landedIn: summary.landedIn,
      error: summary.error,
      checkedAt: summary.checkedAt,
      createdAt: summary.createdAt,
    },
    // TASK_150 T5 — additive: how many addresses this one test went to, and what
    // happened to each, so the UI can report "3 addresses — 2 delivered, 1 failed"
    // (naming the failed one) without a re-fetch or a second source of truth.
    recipientCount: recipientOutcomes.length,
    recipients: recipientOutcomes,
  });
}
