import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { buildQueueItemRows, leadToRecipient } from "@/lib/campaign-recipients";

// Task 26, Piece 4 — add leads to a campaign's recipient list.
// POST /api/campaigns/[id]/recipients/from-leads   body: { leadIds: string[] }
//
// Server-side copy of the picker's guarantees — the client only ever sends lead
// ids; this route re-checks ownership AND validationStatus="valid" itself, so a
// hand-crafted leadId list can't smuggle an unchecked or invalid (or foreign)
// address into a send. mailboxId/variantId are assigned with the same round-robin
// as the CSV/create path via lib/campaign-recipients.ts's buildQueueItemRows.

function parseLeadIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const id = typeof v === "string" ? v.trim() : String(v ?? "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16

  // Same don't-leak-existence convention as every other owned route: a campaign
  // we can't prove belongs to this user reads as 404, not 403.
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    select: { id: true, mailboxIds: true, rotateEvery: true, subjects: true, bodies: true },
  });
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const variants = await prisma.campaignVariant.findMany({
    where: { campaignId: id },
    select: { id: true },
  });
  // Task 29, item 4 — decoupled campaigns store independent subject/body lists (no
  // CampaignVariant rows); legacy campaigns use variant pairs.
  const decoupled = (campaign.subjects ?? []).length > 0 || (campaign.bodies ?? []).length > 0;
  if (!decoupled && variants.length === 0) {
    return NextResponse.json(
      { error: "This campaign has no subject/body content to rotate across." },
      { status: 400 },
    );
  }
  if (campaign.mailboxIds.length === 0) {
    return NextResponse.json(
      { error: "This campaign has no sending mailboxes to rotate across." },
      { status: 400 },
    );
  }

  let body: { leadIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const leadIds = parseLeadIds(body.leadIds);
  if (leadIds.length === 0) {
    return NextResponse.json({ error: "Select at least one lead." }, { status: 400 });
  }

  // Restrict to leads this user owns AND that are validationStatus="valid". An
  // invalid/unchecked/foreign lead in the requested list is silently excluded
  // (the counts below make it obvious nothing was silently sent).
  const selectedLeads = await prisma.lead.findMany({
    where: {
      id: { in: leadIds },
      userId: session.userId,
      validationStatus: "valid",
    },
    select: {
      email: true,
      businessName: true,
      contactName: true,
      phone: true,
      website: true,
    },
  });

  // Dedup within the selection by normalized email (a lead can have a duplicate
  // in the same job, and the user can double-check a row by accident).
  const seen = new Set<string>();
  const recipients = [];
  for (const lead of selectedLeads) {
    const r = leadToRecipient(lead);
    if (!r) continue;
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(r);
  }
  if (recipients.length === 0) {
    return NextResponse.json(
      { error: "None of the selected leads are valid, email-bearing, and yours." },
      { status: 400 },
    );
  }

  // Don't double-queue: skip emails already present in this campaign's items.
  const existingRows = await prisma.emailQueueItem.findMany({
    where: { campaignId: id },
    select: { toEmail: true },
  });
  const existingEmails = new Set(existingRows.map((e) => e.toEmail.toLowerCase()));
  const fresh = recipients.filter((r) => !existingEmails.has(r.email.toLowerCase()));
  const skippedDuplicates = recipients.length - fresh.length;

  if (fresh.length === 0) {
    return NextResponse.json({
      added: 0,
      skipped: 0,
      skippedDuplicates,
      requested: recipients.length,
    });
  }

  const rows = buildQueueItemRows({
    campaignId: id,
    mailboxIds: campaign.mailboxIds,
    ...(decoupled
      ? { subjects: campaign.subjects ?? [], bodies: campaign.bodies ?? [] }
      : { variantRows: variants }),
    recipients: fresh,
    // Continue this campaign's rotation cadence (Task 26, Piece 5b): same
    // rotateEvery, and offset by the number of items already on the roster so a
    // batch added later picks up exactly where previous sends left off instead of
    // restarting mailbox/variant assignment at slot 0.
    rotateEvery: campaign.rotateEvery,
    offsetIndex: existingRows.length,
  });
  const { count } = await prisma.emailQueueItem.createMany({ data: rows });

  return NextResponse.json(
    {
      added: count,
      skipped: fresh.length - count,
      skippedDuplicates,
      requested: recipients.length,
    },
    { status: 201 },
  );
}