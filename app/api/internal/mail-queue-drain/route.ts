import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { transporterForMailbox } from "@/lib/mailer-send";
import { renderMerge } from "@/lib/render-merge";

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

    let transport: ReturnType<typeof transporterForMailbox> | undefined;
    try {
      transport = transporterForMailbox(mailbox);
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unable to decrypt mailbox credentials";
      await prisma.emailQueueItem.updateMany({
        where: { id: { in: items.map((i) => i.id) } },
        data: { status: "failed", error },
      });
      processed += items.length;
      continue;
    }

    for (const item of items) {
      processed += 1;
      // Jitter between sends (a few seconds to <1 min) — never fire a batch back-to-back.
      await new Promise((r) => setTimeout(r, Math.random() * 40_000 + 5_000));

      try {
        // Render at send time from the item's assigned variant + CSV merge vars.
        const variables = (item.variables as Record<string, string> | null) ?? {};
        const subject = item.variant
          ? renderMerge(item.variant.subject, variables)
          : renderMerge(item.campaign.subject, variables);
        const html = item.variant
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

  return NextResponse.json({ processed });
}