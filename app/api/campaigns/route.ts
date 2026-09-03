import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const campaigns = await prisma.emailCampaign.findMany({
    where: { userId: session.userId },
    include: { _count: { select: { items: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(campaigns);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name?: string; subject?: string; bodyHtml?: string; mailboxId?: string;
    toEmails?: string[]; searchJobId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const bodyHtml = body.bodyHtml ?? "";
  const mailboxId = body.mailboxId ?? "";
  const toEmails = Array.isArray(body.toEmails)
    ? body.toEmails.map((e) => String(e).trim()).filter((e) => e.length > 0)
    : [];
  const searchJobId = body.searchJobId ? String(body.searchJobId).trim() : null;

  if (!name || !subject || !bodyHtml.trim() || !mailboxId || toEmails.length === 0) {
    return NextResponse.json(
      { error: "name, subject, bodyHtml, mailboxId and at least one recipient are required" },
      { status: 400 }
    );
  }

  const mailbox = await prisma.mailbox.findFirst({
    where: { id: mailboxId, userId: session.userId },
  });
  if (!mailbox) {
    return NextResponse.json({ error: "Mailbox not found" }, { status: 400 });
  }

  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.emailCampaign.create({
      data: { userId: session.userId, name, subject, bodyHtml, searchJobId },
    });
    await tx.emailQueueItem.createMany({
      data: toEmails.map((toEmail) => ({
        campaignId: created.id,
        mailboxId,
        toEmail,
      })),
    });
    return created;
  });

  return NextResponse.json(campaign);
}