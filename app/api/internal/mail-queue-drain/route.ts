import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireInternalBearer } from "@/lib/internal-auth";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { transporterForMailbox } from "@/lib/mailer-send";
import { classifySmtpError, nextRetryAt } from "@/lib/smtp-error-classify";
import { buildCampaignMessage, normalizeBodyFormat } from "@/lib/campaign-message";
import { renderMerge } from "@/lib/render-merge";
import { probeCampaignPlacement } from "@/lib/deliverability";
import { decideBatchGate } from "@/lib/batch-gate-decision";
import { notifyUser } from "@/lib/notify";
import { notifyAdmin } from "@/lib/telegram";
import { finalizeMailerStretch } from "@/lib/trial";

// Task 33 — a campaign's active pinned-override window (EmailCampaign.pinnedOverride
// as a typed structure rather than raw Json). `remaining` is decremented per
// successful send; at 0 the drain clears it and (on a clean finish) promotes the
// content into the normal rotation.
type PinnedOverride = {
  subject: string;
  bodyHtml: string;
  fromAddress: string;
  remaining: number;
};

// POST only. Gated by bearer token; run via deploy/mail-queue-drain.service timer.
//
// Mailer rewrite behavior:
//  - Only campaigns with status "sending" are drained — a campaign stays at
//    "pending_test_confirm" (its default) until the user's test-send-confirm step
//    unlocks it, so nothing here fires before that gate passes.
//  - Each item already carries the mailboxId and variantId it was rotated to at
//    queue-creation time (true in-run sender + subject/body rotation). This route
//    just renders that item's variant subject/body with the recipient's CSV merge
//    variables at send time, and still respects each mailbox's dailyLimit/sentToday.
export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const mailboxes = await prisma.mailbox.findMany({ where: { active: true } });
  let processed = 0;

  // Task 29, item 6 — batch gate. Snapshot every sending campaign's batchSize and
  // content so we can (a) cap how many of its items get dispatched THIS tick and
  // (b) re-probe deliverability between batches. Only campaigns that actually
  // dispatched at least one item this tick get probed.
  const sendingCampaigns = await prisma.emailCampaign.findMany({
    where: { status: "sending" },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { subject: true, bodyHtml: true } } },
  });
  const batchSizeByCampaign = new Map<string, number>();
  const dispatchedThisTick = new Map<string, number>();
  for (const c of sendingCampaigns) {
    batchSizeByCampaign.set(c.id, Math.max(1, Math.floor(c.batchSize ?? 50)));
    dispatchedThisTick.set(c.id, 0);
  }
  // Task 36 — mailbox fairness. The batch quota (batchSizeByCampaign) is shared
  // campaign-wide but consumed in mailbox-iteration order, so a mailbox with
  // many queued items could greedily fill the ENTIRE batch every tick, starving
  // the campaign's other mailboxes (confirmed live: 66 straight sends through
  // mailbox A, zero through mailbox B on a 2-mailbox, rotateEvery:10 campaign).
  // Give each mailbox a proportional per-tick share: perMailboxCap = ceil(
  // batchSize / mailboxCount). This is an ADDITIVE upper bound per mailbox, not
  // a replacement for the campaign cap — admission still needs BOTH, so total
  // per tick never exceeds the configured batch.
  const perMailboxCapByCampaign = new Map<string, number>();
  for (const c of sendingCampaigns) {
    perMailboxCapByCampaign.set(
      c.id,
      Math.ceil((c.batchSize ?? 50) / Math.max(1, c.mailboxIds.length))
    );
  }
  // dispatchedByMailbox[campaignId][mailboxId] = how many items THIS campaign
  // has admitted from THIS mailbox so far this tick.
  const dispatchedByMailbox = new Map<string, Map<string, number>>();
  const drainedCampaignIds = new Set<string>();
  // Task 33 — snapshot each sending campaign's active pinned-override window. The
  // drain honors the pin (sends the pinned content/From instead of consulting
  // subjects[i%len]/bodies[i%len]/fromAdresses[i%len]), decrements `remaining`
  // per SUCCESSFUL send, and writes the live counter back once at the end of the
  // tick (one DB write per still-active pin, not one per item). A pin window is
  // TEMPORARY by construction — clearing/promoting is handled where the probe
  // runs, not here.
  const pins = new Map<string, PinnedOverride>();
  const pinChanged = new Set<string>();
  // Campaigns whose pin was resolved THIS tick (cleared on a spam hit or a done
  // campaign, or promoted after a clean finish) — the probe/done sections write
  // pinnedOverride themselves, so the end-of-tick write-back must NOT re-inflate
  // these with a live image.
  const pinFinalized = new Set<string>();
  for (const c of sendingCampaigns) {
    const p = c.pinnedOverride as PinnedOverride | null | undefined;
    if (p && typeof p.remaining === "number" && p.remaining > 0) {
      pins.set(c.id, {
        subject: String(p.subject ?? ""),
        bodyHtml: String(p.bodyHtml ?? ""),
        fromAddress: String(p.fromAddress ?? ""),
        remaining: Math.max(0, Math.floor(p.remaining)),
      });
    }
  }

  // Task 35 — parallelize across mailboxes. Mailboxes are independent SMTP
  // connections with independent reputation/daily quotas, so there's no reason to
  // serialize them (before this, mailbox B's whole batch waited for ALL of mailbox
  // A's jittered sends to finish). Each mailbox keeps its OWN sequential inner loop
  // and per-item jitter — only the outer mailbox loop runs concurrently. The batch
  // gate stays safe: admission (dispatchedThisTick/dispatchedByMailbox) happens in a
  // synchronous admit loop with NO await between cap-check and increment, so it's
  // atomic within one Node turn and two mailboxes can never BOTH admit past a
  // campaign's batchSize in the same drain run.
  await Promise.all(
    mailboxes.map(async (mailbox) => {
    let sentToday: number;
    if (mailbox.sentTodayDate !== today) {
      await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { sentToday: 0, sentTodayDate: today },
      });
      sentToday = 0;
    } else {
      sentToday = mailbox.sentToday;
    }

    const remaining = mailbox.dailyLimit - sentToday;
    if (remaining <= 0) return;

    const items = await prisma.emailQueueItem.findMany({
      where: {
        mailboxId: mailbox.id,
        status: "queued",
        campaign: { status: "sending" },
        // A soft_bounce/rate_limited retry reverts an item to "queued" with
        // nextAttemptAt set in the future (see the catch block below) — must
        // not be re-picked up before that backoff window elapses. null means
        // "never failed / no backoff pending", the normal case.
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      take: remaining,
      include: { campaign: true, variant: true },
    });
    if (items.length === 0) return;

    // Batch gate: only take the first `batchSize` items of each campaign this tick,
    // so the drain pauses at the batch boundary and lets the probe gate the next one.
    // Task 36 — ALSO cap per-mailbox at this campaign's per-mailbox share of the
    // batch (perMailboxCapByCampaign), so one well-stocked mailbox can't consume
    // the whole quota and starve its siblings in the same campaign on this tick.
    const admit: typeof items = [];
    for (const item of items) {
      const used = dispatchedThisTick.get(item.campaignId) ?? 0;
      const cap = batchSizeByCampaign.get(item.campaignId) ?? Number.MAX_SAFE_INTEGER;
      if (used >= cap) continue;
      const mboxCap = perMailboxCapByCampaign.get(item.campaignId) ?? Number.MAX_SAFE_INTEGER;
      let byMailbox = dispatchedByMailbox.get(item.campaignId);
      if (!byMailbox) {
        byMailbox = new Map();
        dispatchedByMailbox.set(item.campaignId, byMailbox);
      }
      const usedByMailbox = byMailbox.get(mailbox.id) ?? 0;
      if (usedByMailbox >= mboxCap) continue;
      admit.push(item);
      dispatchedThisTick.set(item.campaignId, used + 1);
      byMailbox.set(mailbox.id, usedByMailbox + 1);
      drainedCampaignIds.add(item.campaignId);
    }
    if (admit.length === 0) return;

    let transport: Awaited<ReturnType<typeof transporterForMailbox>> | undefined;
    try {
      transport = await transporterForMailbox(mailbox);
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unable to build SMTP transport";
      await prisma.emailQueueItem.updateMany({
        where: { id: { in: admit.map((i) => i.id) } },
        data: { status: "failed", error },
      });
      processed += admit.length;
      return;
    }

    for (const item of admit) {
      processed += 1;
      // Jitter between sends — never fire a batch back-to-back. Task 35: the
      // bounds are now configurable per campaign (EmailCampaign.minSendDelaySeconds
      // / maxSendDelaySeconds, default 5/45 — exactly matching the pre-Task-35
      // hardcoded `Math.random() * 40_000 + 5_000`, so existing campaigns are
      // unchanged). Clamped here as a server-side safety floor (min >= 1, max >=
      // min) so a misconfigured 0-0 "bot blast" can never send back-to-back even if
      // the create UI was bypassed. The jitter algorithm itself is untouched:
      // min + random * (max - min).
      const dayDelayMin = Math.max(1, Math.floor(item.campaign.minSendDelaySeconds ?? 5));
      const dayDelayMax = Math.max(dayDelayMin, Math.floor(item.campaign.maxSendDelaySeconds ?? 45));
      await new Promise((r) =>
        setTimeout(r, (dayDelayMin + Math.random() * (dayDelayMax - dayDelayMin)) * 1000)
      );

      try {
        // Render at send time from the item's assigned variant + CSV merge vars.
        // Task 29, item 4 — decoupled campaigns store the resolved subject/body
        // snapshot on the item itself (no variant pair); legacy campaigns fall back
        // to the item's variant, then the campaign's legacy single fields.
        const variables = (item.variables as Record<string, string> | null) ?? {};
        // Task 33 — during a pinned-override window, every send for this campaign
        // uses the pinned content/From instead of the item's rotation snapshot.
        // The pin is honored for exactly its `remaining` sends — once it hits 0
        // MID-tick the remaining items of this tick already revert to the normal
        // rotation snapshots (a window is exactly `pinCount` sends, no more).
        const head = pins.get(item.campaignId);
        const pin = head && head.remaining > 0 ? head : null;
        const subject =
          pin
            ? renderMerge(pin.subject, variables)
            : item.resolvedSubject != null
              ? renderMerge(item.resolvedSubject, variables)
              : item.variant
                ? renderMerge(item.variant.subject, variables)
                : renderMerge(item.campaign.subject, variables);
        const html =
          pin
            ? renderMerge(pin.bodyHtml, variables)
            : item.resolvedBodyHtml != null
              ? renderMerge(item.resolvedBodyHtml, variables)
              : item.variant
                ? renderMerge(item.variant.bodyHtml, variables)
                : renderMerge(item.campaign.bodyHtml, variables);
        const from =
          pin && pin.fromAddress
            ? pin.fromAddress
            : item.resolvedFromAddress || mailbox.fromAddresses[0] || mailbox.username;

        // The unsubscribe mechanism (RFC 8058 headers + a visible footer link)
        // and the plaintext alternative are built by lib/campaign-message.ts —
        // see that module for why both matter, and for why they are deliberately
        // NOT assembled here. Everything above is only what is specific to a
        // QUEUED send: which variant/pin supplied the content, and which From
        // address this recipient rotates to.
        // Task 144 — assembled by the SAME builder the test/preview send uses, so
        // a test message IS the message a real recipient gets (plaintext
        // alternative + List-Unsubscribe headers + visible footer). These used to
        // be built separately here and in lib/deliverability.ts, and they drifted:
        // the test send went out HTML-only with no unsubscribe, so the
        // deliverability gate was grading a message nobody would ever receive.
        // See lib/campaign-message.ts.
        const message = buildCampaignMessage({
          subject,
          bodyHtml: html,
          from,
          toEmail: item.toEmail,
          userId: item.campaign.userId,
          // Task 144 — a text-only campaign omits the HTML part entirely.
          format: normalizeBodyFormat(item.campaign.bodyFormat),
        });

        await transport!.sendMail({
          // Task 30, item 4 — multi-From rotation: prefer the per-item resolved
          // From address (computed at queue-build time), else the mailbox's first
          // configured From address, else fall back to the SMTP username. Task 33 —
          // a pinned override's proven From wins over all of these while set.
          from,
          to: item.toEmail,
          ...message,
        });
        await prisma.emailQueueItem.update({
          where: { id: item.id },
          data: { status: "sent", sentAt: new Date() },
        });
        sentToday += 1;
        await prisma.mailbox.update({
          where: { id: mailbox.id },
          data: { sentToday: { increment: 1 } },
        });
        // Task 33 — decrement the running pin counter on SUCCESSFUL sends only (a
        // failed send isn't a send, so it shouldn't consume a pin slot).
        if (pin) {
          pin.remaining = Math.max(0, pin.remaining - 1);
          pinChanged.add(item.campaignId);
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : "Unknown error";
        const errorCategory = classifySmtpError(e);
        const attempts = item.attempts + 1;
        // soft_bounce/rate_limited get a backoff window and revert to "queued"
        // (picked up again once nextAttemptAt elapses, see the SELECT above);
        // hard_bounce/auth_failed/other are terminal for this item — see
        // lib/smtp-error-classify.ts's RETRY_DELAY_MINUTES for why each
        // category is or isn't retried.
        const retryAt = nextRetryAt(errorCategory, attempts);
        await prisma.emailQueueItem.update({
          where: { id: item.id },
          data: {
            status: retryAt ? "queued" : "failed",
            error,
            errorCategory,
            attempts,
            nextAttemptAt: retryAt,
          },
        });
        // A hard bounce means the ADDRESS is bad, not this one campaign's
        // content — suppress it for this user so no future campaign of
        // theirs queues it again (lib/campaign-recipients.ts's filterSuppressed).
        if (errorCategory === "hard_bounce") {
          const email = item.toEmail.trim().toLowerCase();
          await prisma.suppression.upsert({
            where: { userId_email: { userId: item.campaign.userId, email } },
            create: { userId: item.campaign.userId, email, reason: "hard_bounce" },
            update: {},
          });
        }
        // Do NOT increment sentToday on failure.
      }
    }

    // Mark affected campaigns "done" once none of their items are still queued.
    const campaignIds = [...new Set(items.map((i) => i.campaignId))];
    for (const campaignId of campaignIds) {
      const queued = await prisma.emailQueueItem.count({
        where: { campaignId, status: "queued" },
      });
      if (queued === 0) {
        // Task 33 — a pin whose window never finished because the recipients ran
        // out is moot; clear it so the campaign isn't left holding a stale active
        // pin (status "done" never drains again, so it can't be honored anyway).
        // No promotion here — a pin only promotes on a CLEAN completed window (see
        // the batch-gate block below), and running out of recipients isn't that.
        pinFinalized.add(campaignId);
        // Tier 1 trial — finalize the mailer stretch in the SAME transaction as
        // the status flip, gated on the updateMany actually having transitioned
        // this row (guards the same status:"sending" race the updateMany's WHERE
        // already protects against — two mailboxes finishing this campaign's
        // last items in the same tick must not double-record the stretch).
        const campaignSnapshot = items.find((i) => i.campaignId === campaignId)?.campaign;
        await prisma.$transaction(async (tx) => {
          const { count } = await tx.emailCampaign.updateMany({
            where: { id: campaignId, status: "sending" },
            data: { status: "done", pinnedOverride: Prisma.DbNull },
          });
          if (count > 0 && campaignSnapshot) {
            await finalizeMailerStretch(tx, {
              id: campaignSnapshot.id,
              userId: campaignSnapshot.userId,
              sendingStartedAt: campaignSnapshot.sendingStartedAt,
            });
          }
        });
      }
    }
    }));

  // Task 29, item 6 — batch gate: after dispatching a batch to a campaign, probe
  // its test mailbox and gate the NEXT batch. "inbox" => keep sending; "spam" or
  // "unknown" => pause the campaign, notify the owner, and let them decide
  // (continue-anyway / switch subject / stop) via POST /api/campaigns/[id]/deliverability-decision.
  // Built at the drain (shared send-engine) level, so hand-built campaigns AND
  // automation-triggered ones (which reuse createCampaign — no automation-specific
  // code here) both get it automatically.
  for (const c of sendingCampaigns) {
    if (!drainedCampaignIds.has(c.id)) continue;

    // A campaign that just drained its LAST queued item was already flipped to
    // "done" by the loop above, in this same tick. Without this check the probe
    // below still ran anyway, and — with a human-assisted testRecipientOverride
    // set (which always reports landedIn:"unknown", by design, since there's no
    // automated way to verify placement in an arbitrary human inbox) — its
    // "pause for a decision" branch clobbered "done" back to
    // "paused_deliverability", even though there was no next batch left to
    // protect. Confirmed live 2026-09-28: a 4-recipient campaign showed all 4
    // rows "Sent" yet the campaign sat at "paused_deliverability" regardless.
    // The batch gate exists to protect a batch that hasn't been sent YET; once
    // nothing is left queued, there is nothing left for it to gate.
    const stillQueued = await prisma.emailQueueItem.count({
      where: { campaignId: c.id, status: "queued" },
    });
    if (stillQueued === 0) continue;

    const activeMailboxes = mailboxes
      .filter((m) => c.mailboxIds.includes(m.id))
      .sort((a, b) => (a.createdAt ?? new Date(0)).getTime() - (b.createdAt ?? new Date(0)).getTime());
    if (activeMailboxes.length === 0) continue;

    // Task 33 — during a pinned window the batch-gate probe must judge the SAME
    // content (and From) the pinned sends actually used, not the campaign's stored
    // rotation — the whole point of the probe is to answer \"is the content we're
    // about to keep sending actually making it to the inbox?\" The pin doesn't
    // turn the safety check off; it only decides what content the check uses.
    const pin = pins.get(c.id);
    const probe = await probeCampaignPlacement({
      campaignId: c.id,
      userId: c.userId,
      mailboxes: activeMailboxes,
      subjects: pin ? [pin.subject] : c.subjects,
      bodies: pin ? [pin.bodyHtml] : c.bodies,
      variants: pin ? undefined : c.variants.map((v) => ({ subject: v.subject, bodyHtml: v.bodyHtml })),
      overrideRecipient: c.testRecipientOverride,
      // Task 144 — probe the same message SHAPE the real sends will use.
      bodyFormat: c.bodyFormat,
      ...(pin && pin.fromAddress ? { from: pin.fromAddress } : {}),
    });

    // TASK_150 T3 — what does this boundary MEAN? In human-assisted mode
    // (testRecipientOverride) landedIn is structurally "unknown" BY DESIGN: there
    // is no IMAP account watching an arbitrary human inbox, so the old single
    // predicate (`landedIn === "inbox"`) was false on EVERY batch and each
    // boundary was announced to the user as a failed deliverability check —
    // "could not be verified to have reached the inbox" — after a test send that
    // actually succeeded. The decision is now named explicitly
    // (lib/batch-gate-decision.ts): manual mode resolves to human_confirm; only
    // the automated seed-mailbox path can produce pause_failed. The probe itself
    // still runs in both modes — in manual mode its send IS the test the owner is
    // being asked to check, and its DeliverabilityCheck row is what the campaign
    // page's "sent - not auto-verified" line reads.
    //
    // NOTHING about the pause is relaxed: `safe` is still false for manual mode,
    // so the campaign still stops at "paused_deliverability" (kept deliberately —
    // app/api/campaigns/[id]/deliverability-decision and the initial
    // pending_test_confirm gate both key off it) and still never auto-continues.
    const gate = decideBatchGate({
      overrideRecipient: c.testRecipientOverride,
      landedIn: probe.landedIn,
    });
    const safe = gate.action === "continue";

    // Task 33 — the pin window finished cleanly THIS tick (remaining hit 0 AND the
    // batch probe stayed in the inbox — i.e. no spam hit through the whole pinned
    // stretch): clear the pin AND promote the proven content into the normal
    // rotation (Task 32's mechanism), so it keeps serving the campaign after the
    // window instead of being forgotten. A pin is a bet the user made, not a
    // bypass of the safety net — if the probe had come back spam/unknown we'd fall
    // through to the pause below instead of promoting.
    if (pin && pin.remaining <= 0 && safe) {
      const hasDecoupled = Array.isArray(c.subjects) && c.subjects.length > 0;
      const legacy = c.variants?.[0];
      const baseSubjects = hasDecoupled ? [...c.subjects] : legacy?.subject ? [legacy.subject] : [];
      const baseBodies = hasDecoupled ? [...(Array.isArray(c.bodies) ? c.bodies : [])] : legacy?.bodyHtml ? [legacy.bodyHtml] : [];
      // Front-insert unless the pinned content is already index 0 (no-op duplicate),
      // matching the add_edit_and_continue promote exactly.
      const subjects = baseSubjects[0] === pin.subject ? baseSubjects : [pin.subject, ...baseSubjects.filter((s) => s !== "")];
      const bodies = baseBodies[0] === pin.bodyHtml ? baseBodies : [pin.bodyHtml, ...baseBodies.filter((b) => b !== "")];
      await prisma.emailCampaign.update({
        where: { id: c.id },
        data: { subjects, bodies, pinnedOverride: Prisma.DbNull },
      });
      // Promote the proven From too — prepend it to each of the campaign's sending
      // mailboxes' rotations so the whole proven combination (not just subject/body)
      // is preferred going forward.
      if (pin.fromAddress && activeMailboxes.length > 0) {
        const mbs = await prisma.mailbox.findMany({
          where: { id: { in: activeMailboxes.map((m) => m.id) } },
          select: { id: true, fromAddresses: true },
        });
        for (const mb of mbs) {
          const fa = Array.isArray(mb.fromAddresses) && mb.fromAddresses.length > 0
            ? (mb.fromAddresses[0] === pin.fromAddress ? mb.fromAddresses : [pin.fromAddress, ...mb.fromAddresses])
            : [pin.fromAddress];
          if (fa !== mb.fromAddresses) {
            await prisma.mailbox.update({ where: { id: mb.id }, data: { fromAddresses: fa } });
          }
        }
      }
      pinFinalized.add(c.id);
    }

    if (safe) continue; // next tick sends the next batch (and, if a pin is active but unfinished, its remaining sends)

    // landedIn "spam" or "unknown" → pause and ask the owner. Remaining queued
    // items stay queued; the campaign leaves status "sending" so the drain skips
    // it until the owner makes a decision. Task 33 — if a pin was active (whether
    // its window finished OR a spam hit landed mid-window), clear the pin too: a
    // prove-good bet that just hit spam is no longer good, so we fall back to the
    // normal decision box exactly like an unpinned campaign — never keep trusting
    // a pin that just failed. When the window finished but the probe came back
    // NOT-safe, this also means no promotion happened above (that required `safe`).
    const clearPin = !!pin && (pin.remaining <= 0 || !safe);
    if (clearPin) pinFinalized.add(c.id);
    // Tier 1 trial — finalize the mailer stretch (this loop runs sequentially
    // per campaign, not concurrently, so no updateMany race guard is needed
    // here unlike the "done" transition above).
    await prisma.$transaction(async (tx) => {
      await finalizeMailerStretch(tx, { id: c.id, userId: c.userId, sendingStartedAt: c.sendingStartedAt });
      await tx.emailCampaign.update({
        where: { id: c.id },
        data: { status: "paused_deliverability", ...(clearPin ? { pinnedOverride: Prisma.DbNull } : {}) },
      });
    });

    // Best-effort owner notification (SpaceWorker's own transactional email, plus
    // the owner's optionally-enabled Telegram + agent-chat channels, fanned out by
    // lib/notify.ts; a failure must never break the drain — each channel already
    // audit-logs its own outcome).
    try {
      const placement =
        probe.landedIn === "spam"
          ? "landed in the spam folder"
          : "could not be verified to have reached the inbox";
      const campaignLink = `${env.appBaseUrl}/dashboard/campaigns/${c.id}`;
      // TASK_150 T3 — frame the boundary as what it actually IS.
      //
      // Manual mode (human_confirm) is the owner's turn, not a failure: the test
      // message was sent, nothing was auto-verified (we have no access to that
      // inbox), and the campaign is waiting on the human — so the copy is neutral
      // and matches what TASK_144 already ships in the UI
      // ("sent - not auto-verified", app/dashboard/campaigns/[id]/page.tsx). It
      // also states plainly which mode the NEXT gate will use, so a manual test
      // can never read as an automatic check that just failed, and no silent
      // fallback to the seed-mailbox path is implied.
      //
      // Automated mode keeps its existing wording verbatim: there, "landed in the
      // spam folder" / "could not be verified" are honest descriptions of a check
      // that genuinely ran and did not pass.
      const copy =
        gate.action === "human_confirm"
          ? {
              subject: `SpaceWorker: "${c.name}" is ready for your test confirmation`,
              emailHtml:
                `<p>The next batch of campaign <strong>${c.name}</strong> is ready to send. A test message was` +
                ` sent to your test recipient <strong>${gate.recipient}</strong> — sent, not auto-verified, since` +
                ` there is no automated way to check that inbox.</p>` +
                `<p>Open the campaign, check that inbox, and confirm &quot;It&apos;s in the inbox — continue the` +
                ` next batch&quot; when you are ready. You can also switch subject or stop.</p>` +
                `<p>The next batch gate will use this same mode: manual confirmation via` +
                ` <strong>${gate.recipient}</strong>.</p>`,
              telegramText:
                `📬 Campaign "${c.name}" is ready for your confirmation — a test message was sent to` +
                ` ${gate.recipient} (sent, not auto-verified). Check that inbox, then open the campaign to` +
                ` continue the next batch, switch subject, or stop. The next gate will again wait for your` +
                ` manual confirmation.`,
              agentText:
                `Campaign "${c.name}" reached a batch boundary in manual test mode: the test message was sent to` +
                ` ${gate.recipient} (sent, not auto-verified). Open the campaign to confirm "it's in the inbox"` +
                ` and continue the next batch, switch subject, or stop. The next gate will again use manual` +
                ` confirmation.`,
            }
          : {
              subject: `SpaceWorker: "${c.name}" paused on a deliverability check`,
              emailHtml:
                `<p>The batch send for campaign <strong>${c.name}</strong> was paused after its latest` +
                ` deliverability check ${placement} on your test mailbox.</p>` +
                `<p>Open the campaign to review and choose Continue, Switch subject, or Stop.</p>`,
              telegramText:
                `⚠️ Campaign "${c.name}" was paused — its latest deliverability check ${placement}. ` +
                `Open the campaign to Continue, Switch subject, or Stop.`,
              agentText:
                `Campaign "${c.name}" was paused after its latest deliverability check ${placement}. ` +
                `Open the campaign to review and choose Continue, Switch subject, or Stop.`,
            };
      await notifyUser(c.userId, {
        eventType: "batch_deliverability_pause",
        subject: copy.subject,
        emailHtml: copy.emailHtml,
        telegramText: copy.telegramText,
        agentText: copy.agentText,
        link: campaignLink,
        // Task 38 — attach the exact stuck-campaign widget so the agent chat panel
        // renders the familiar status row for this specific paused campaign.
        inlineWidget: {
          type: "campaign_status_list",
          campaigns: [
            {
              id: c.id,
              name: c.name,
              status: "paused_deliverability",
              landedIn: probe.landedIn ?? null,
              lastError: null,
              overrideRecipient: Boolean(c.testRecipientOverride?.trim()),
            },
          ],
        },
      });
    } catch {
      // Best-effort; the pause + DeliverabilityCheck (already recorded by the
      // probe) persist regardless.
    }

    // Task 50 — the OWNER gets an admin-level Telegram alert too (distinct from
    // the user-facing fan-out above): paused_deliverability is the platform's
    // own sending reputation at stake, not just the customer's, and the admin
    // previously had no notification hook for it at all. Fire-and-forget like
    // every notifyAdmin call — never able to break the drain.
    // TASK_150 T3 — the admin alert is corrected the same way, so an internal
    // reader can't label a manual boundary a failed check either. A pause in
    // manual mode still matters (a campaign is stopped and someone must act), but
    // it is the owner's turn, not the platform's sending reputation slipping.
    void notifyAdmin(
      gate.action === "human_confirm"
        ? `📬 [ADMIN] Campaign "${c.name}" (${c.userId}) reached a batch boundary in MANUAL test mode (recipient ${gate.recipient}) — waiting on the owner's confirmation, no failed check. landedIn=${probe.landedIn ?? "unknown"}. Open ${env.appBaseUrl}/dashboard/campaigns/${c.id}`
        : `⚠️ [ADMIN] Campaign "${c.name}" (${c.userId}) paused on a deliverability check — landedIn=${probe.landedIn ?? "unknown"}. Open ${env.appBaseUrl}/dashboard/campaigns/${c.id}`,
    );
  }

  // Task 33 — persist the live `remaining` for pins that are still running this
  // tick (they had sets sent, the probe came back safe, and the window isn't done
  // yet). Completed/cleared pins were already updated above (promote on a clean
  // finish, clear on a spam hit or a done campaign); this is the one remaining
  // write so a partially-consumed pin is durable across ticks instead of being
  // re-inflated from the stale full count next time by the drain.
  for (const cid of pinChanged) {
    const pin = pins.get(cid);
    if (pin && pin.remaining > 0 && !pinFinalized.has(cid)) {
      await prisma.emailCampaign.update({
        where: { id: cid },
        data: {
          pinnedOverride: {
            subject: pin.subject,
            bodyHtml: pin.bodyHtml,
            fromAddress: pin.fromAddress,
            remaining: pin.remaining,
          },
        },
      });
    }
  }

  return NextResponse.json({ processed });
}