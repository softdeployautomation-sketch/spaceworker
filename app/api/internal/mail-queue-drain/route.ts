import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { transporterForMailbox } from "@/lib/mailer-send";
import { renderMerge } from "@/lib/render-merge";
import { probeCampaignPlacement } from "@/lib/deliverability";
import { sendEmail } from "@/lib/email";

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
  const drainedCampaignIds = new Set<string>();

  for (const mailbox of mailboxes) {
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
    if (remaining <= 0) continue;

    const items = await prisma.emailQueueItem.findMany({
      where: {
        mailboxId: mailbox.id,
        status: "queued",
        campaign: { status: "sending" },
      },
      take: remaining,
      include: { campaign: true, variant: true },
    });
    if (items.length === 0) continue;

    // Batch gate: only take the first `batchSize` items of each campaign this tick,
    // so the drain pauses at the batch boundary and lets the probe gate the next one.
    const admit: typeof items = [];
    for (const item of items) {
      const used = dispatchedThisTick.get(item.campaignId) ?? 0;
      const cap = batchSizeByCampaign.get(item.campaignId) ?? Number.MAX_SAFE_INTEGER;
      if (used >= cap) continue;
      admit.push(item);
      dispatchedThisTick.set(item.campaignId, used + 1);
      drainedCampaignIds.add(item.campaignId);
    }
    if (admit.length === 0) continue;

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
      continue;
    }

    for (const item of admit) {
      processed += 1;
      // Jitter between sends (a few seconds to <1 min) — never fire a batch back-to-back.
      await new Promise((r) => setTimeout(r, Math.random() * 40_000 + 5_000));

      try {
        // Render at send time from the item's assigned variant + CSV merge vars.
        // Task 29, item 4 — decoupled campaigns store the resolved subject/body
        // snapshot on the item itself (no variant pair); legacy campaigns fall back
        // to the item's variant, then the campaign's legacy single fields.
        const variables = (item.variables as Record<string, string> | null) ?? {};
        const subject =
          item.resolvedSubject != null
            ? renderMerge(item.resolvedSubject, variables)
            : item.variant
              ? renderMerge(item.variant.subject, variables)
              : renderMerge(item.campaign.subject, variables);
        const html =
          item.resolvedBodyHtml != null
            ? renderMerge(item.resolvedBodyHtml, variables)
            : item.variant
              ? renderMerge(item.variant.bodyHtml, variables)
              : renderMerge(item.campaign.bodyHtml, variables);

        await transport!.sendMail({
          from: mailbox.fromAddress || mailbox.username,
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
        await prisma.emailCampaign.updateMany({
          where: { id: campaignId, status: "sending" },
          data: { status: "done" },
        });
      }
    }
  }

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

    const probe = await probeCampaignPlacement({
      campaignId: c.id,
      userId: c.userId,
      mailboxes: activeMailboxes,
      subjects: c.subjects,
      bodies: c.bodies,
      variants: c.variants.map((v) => ({ subject: v.subject, bodyHtml: v.bodyHtml })),
      overrideRecipient: c.testRecipientOverride,
    });

    if (probe.landedIn === "inbox") continue; // safe — next tick sends the next batch

    // landedIn "spam" or "unknown" → pause and ask the owner. Remaining queued
    // items stay queued; the campaign leaves status "sending" so the drain skips
    // it until the owner makes a decision.
    await prisma.emailCampaign.update({
      where: { id: c.id },
      data: { status: "paused_deliverability" },
    });

    // Best-effort owner notification (SpaceWorker's own transactional email; a
    // failure must never break the drain — sendEmail already audit-logs internally).
    try {
      const owner = await prisma.user.findUnique({ where: { id: c.userId }, select: { email: true } });
      if (owner?.email) {
        const placement = probe.landedIn === "spam"
          ? "landed in the spam folder"
          : "could not be verified to have reached the inbox";
        await sendEmail({
          to: owner.email,
          subject: `SpaceWorker: "${c.name}" paused on a deliverability check`,
          html:
            `<p>The batch send for campaign <strong>${c.name}</strong> was paused after its latest` +
            ` deliverability check ${placement} on your test mailbox.</p>` +
            `<p>Open the campaign to review and choose Continue, Switch subject, or Stop.</p>`,
          eventType: "batch_deliverability_pause",
        });
      }
    } catch {
      // Best-effort; the pause + DeliverabilityCheck (already recorded by the
      // probe) persist regardless.
    }
  }

  return NextResponse.json({ processed });
}