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
  if (!parsed && !searchJobId) {
    return NextResponse.json(
      { error: "Upload a recipient CSV or pick a Lead Extractor job" },
      { status: 400 }
    );
  }
  if (parsed && parsed.recipients.length === 0) {
    return NextResponse.json(
      { error: "No valid recipients in the CSV" },
      { status: 400 }
    );
  }

  // Confirm every mailbox belongs to this user, and that searchJob (if
  // provided) does too — checked unconditionally, regardless of which
  // recipient source is actually used below. A previous draft only checked
  // ownership inside the "no CSV" branch, so a request supplying BOTH a csv
  // AND a searchJobId for a job it didn't own would take the CSV recipient
  // path (skipping this check entirely) while still persisting the other
  // user's searchJobId onto EmailCampaign — a stored cross-tenant reference,
  // even though the recipients themselves came from the (valid) CSV.
  const ownedMailboxes = await prisma.mailbox.findMany({
    where: { id: { in: mailboxIds }, userId: session.userId },
    select: { id: true },
  });
  if (ownedMailboxes.length !== mailboxIds.length) {
    return NextResponse.json({ error: "One or more mailboxes not found" }, { status: 400 });
  }
  if (searchJobId) {
    const owned = await prisma.searchJob.findFirst({
      where: { id: searchJobId, userId: session.userId },
      select: { id: true },
    });
    if (!owned) {
      return NextResponse.json({ error: "Search job not found" }, { status: 400 });
    }
  }

  // Recipients come from EITHER an uploaded CSV OR a Lead Extractor job's own
  // leads (never both — CSV wins if somehow both are given, matching the
  // pre-existing precedence of "parsed" being computed from body.csv first).
  // Using leads directly means the sender's recipient list is exactly the
  // emails this app already extracted — no manual CSV export/re-upload
  // round trip. Only the email + a couple of useful merge variables travel
  // across; phone/website/snippet aren't relevant to sending an email.
  let recipients: { email: string; variables: Record<string, unknown> }[];
  if (parsed) {
    recipients = parsed.recipients;
  } else {
    const leads = await prisma.lead.findMany({
      where: { searchJobId: searchJobId!, userId: session.userId, email: { not: null } },
      select: { email: true, contactName: true, businessName: true },
    });
    const seen = new Set<string>();
    recipients = [];
    for (const l of leads) {
      const email = (l.email ?? "").trim();
      if (!email || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      recipients.push({
        // Preserve original casing, same as the CSV path (lib/csv.ts's
        // parseRecipientsCsv) — lowercase only for the dedup comparison
        // above, not for the stored/sent address.
        email,
        variables: { contactName: l.contactName ?? "", businessName: l.businessName ?? "" },
      });
    }
    if (recipients.length === 0) {
      return NextResponse.json(
        { error: "That job has no leads with an email address." },
        { status: 400 }
      );
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
    { campaign, recipientCount: recipients.length, rowErrors: parsed?.errors ?? [] },
    { status: 201 }
  );
}