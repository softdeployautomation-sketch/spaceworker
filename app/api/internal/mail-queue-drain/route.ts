import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { transporterForMailbox } from "@/lib/mailer-send";
import { renderMerge } from "@/lib/render-merge";
import { probeCampaignPlacement } from "@/lib/deliverability";
import { notifyUser } from "@/lib/notify";

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
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
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

    let transport: ReturnType<typeof transporterForMailbox> | undefined;
    try {
      transport = transporterForMailbox(mailbox);
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unable to decrypt mailbox credentials";
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

        await transport!.sendMail({
          // Task 30, item 4 — multi-From rotation: prefer the per-item resolved
          // From address (computed at queue-build time), else the mailbox's first
          // configured From address, else fall back to the SMTP username. Task 33 —
          // a pinned override's proven From wins over all of these while set.
          from,
          to: item.toEmail,
          subject,
          html,
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
        await prisma.emailQueueItem.update({
          where: { id: item.id },
          data: { status: "failed", error },
        });
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
        await prisma.emailCampaign.updateMany({
          where: { id: campaignId, status: "sending" },
          data: { status: "done", pinnedOverride: Prisma.DbNull },
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
      ...(pin && pin.fromAddress ? { from: pin.fromAddress } : {}),
    });

    const safe = probe.landedIn === "inbox";

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
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { status: "paused_deliverability", ...(clearPin ? { pinnedOverride: Prisma.DbNull } : {}) },
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
      await notifyUser(c.userId, {
        eventType: "batch_deliverability_pause",
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