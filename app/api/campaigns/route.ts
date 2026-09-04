import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { parseRecipientsCsv } from "@/lib/csv";

interface VariantInput {
  subject?: string;
  bodyHtml?: string;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const campaigns = await prisma.emailCampaign.findMany({
    where: { userId: session.userId },
    include: {
      variants: { orderBy: { createdAt: "asc" } },
      _count: { select: { items: true } },
    },
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
    name?: string;
    mailboxIds?: string[];
    variants?: VariantInput[];
    csv?: string;
    searchJobId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const mailboxIds = Array.isArray(body.mailboxIds)
    ? body.mailboxIds.map((m) => String(m).trim()).filter((m) => m.length > 0)
    : [];
  const variants = Array.isArray(body.variants)
    ? body.variants
        .map((v) => ({ subject: (v.subject ?? "").trim(), bodyHtml: v.bodyHtml ?? "" }))
        .filter((v) => v.subject.length > 0 && v.bodyHtml.trim().length > 0)
    : [];
  const searchJobId = body.searchJobId ? String(body.searchJobId).trim() : null;

  const parsed = typeof body.csv === "string" && body.csv.trim() !== ""
    ? parseRecipientsCsv(body.csv)
    : null;

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (mailboxIds.length === 0) {
    return NextResponse.json(
      { error: "Select at least one sending mailbox" },
      { status: 400 }
    );
  }
  if (variants.length === 0) {
    return NextResponse.json(
      { error: "At least one subject/body variant is required" },
      { status: 400 }
    );
  }
  if (!parsed) {
    return NextResponse.json({ error: "Upload a recipient CSV" }, { status: 400 });
  }
  if (parsed.recipients.length === 0) {
    return NextResponse.json(
      { error: "No valid recipients in the CSV" },
      { status: 400 }
    );
  }

  // Confirm every mailbox belongs to this user, and that searchJob (if provided)
  // does too — the rotation below must never reference another user's rows.
  const ownedMailboxes = await prisma.mailbox.findMany({
    where: { id: { in: mailboxIds }, userId: session.userId },
    select: { id: true },
  });
  if (ownedMailboxes.length !== mailboxIds.length) {
    return NextResponse.json({ error: "One or more mailboxes not found" }, { status: 400 });
  }
  if (searchJobId) {
    const job = await prisma.searchJob.findFirst({
      where: { id: searchJobId, userId: session.userId },
      select: { id: true },
    });
    if (!job) {
      return NextResponse.json({ error: "Search job not found" }, { status: 400 });
    }
  }

  // Round-robin rotation across sender mailboxes and subject/body variants, both
  // assigned here at queue-creation time. This is "true in-run rotation": one
  // campaign's single send spreads each recipient across the selected senders and
  // variants (the drain route then still respects each mailbox's dailyLimit when it
  // actually sends). Recorded as variantId/mailboxId per item for later "did
  // variant B convert better" analysis and per-send debugging.
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.emailCampaign.create({
      data: {
        userId: session.userId,
        name,
        subject: "",
        bodyHtml: "",
        status: "pending_test_confirm",
        mailboxIds,
        searchJobId,
      },
    });

    const variantRows: { id: string; subject: string; bodyHtml: string }[] = [];
    for (const v of variants) {
      const row = await tx.campaignVariant.create({
        data: { campaignId: created.id, subject: v.subject, bodyHtml: v.bodyHtml },
      });
      variantRows.push(row);
    }

    const recipients = parsed.recipients;
    await tx.emailQueueItem.createMany({
      data: recipients.map((r, i) => ({
        campaignId: created.id,
        mailboxId: mailboxIds[i % mailboxIds.length],
        variantId: variantRows[i % variantRows.length].id,
        toEmail: r.email,
        variables: r.variables as Prisma.InputJsonValue,
      })),
    });

    return created;
  });

  return NextResponse.json(
    { campaign, recipientCount: parsed.recipients.length, rowErrors: parsed.errors },
    { status: 201 }
  );
}