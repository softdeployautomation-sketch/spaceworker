import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/mailbox-crypto";
import nodemailer, { type Transporter } from "nodemailer";

// POST only. Gated by bearer token; run via deploy/mail-queue-drain.service timer.
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
      include: { campaign: true },
    });
    if (items.length === 0) continue;

    let transport: Transporter | undefined;
    try {
      const password = decryptSecret(
        mailbox.encryptedPassword,
        mailbox.passwordIv,
        mailbox.passwordTag
      );
      transport = nodemailer.createTransport({
        host: mailbox.host,
        port: mailbox.port,
        secure: mailbox.secure,
        auth: { user: mailbox.username, pass: password },
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unknown error";
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
        await transport!.sendMail({
          from: mailbox.username,
          to: item.toEmail,
          subject: item.campaign.subject,
          html: item.campaign.bodyHtml,
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