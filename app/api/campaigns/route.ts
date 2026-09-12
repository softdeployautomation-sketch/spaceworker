import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { parseRecipientsCsv } from "@/lib/csv";
import { leadToRecipient } from "@/lib/campaign-recipients";
import { createCampaign } from "@/lib/campaign-create";

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
    leadIds?: unknown;
    rotateEvery?: unknown;
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
  // Task 26, Piece 4 — third recipient source: an explicit list of validated Lead
  // ids (created atomically with the campaign). Dedup the raw list up front.
  const leadIdRaw = Array.isArray(body.leadIds) ? body.leadIds : [];
  const leadIds: string[] = [];
  {
    const seen = new Set<string>();
    for (const v of leadIdRaw) {
      const id = typeof v === "string" ? v.trim() : String(v ?? "").trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        leadIds.push(id);
      }
    }
  }
  // Task 26, Piece 5b — how many consecutive recipients share a mailbox/subject
  // before the rotation advances. Clamped server-side like every other numeric
  // knob in this app (see maxResults/minResults in app/api/jobs/route.ts); no
  // realistic campaign needs >1000 emails between rotations.
  const rotateEvery = Math.max(1, Math.min(1000, Math.floor(Number(body.rotateEvery ?? 1))));

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
  if (!parsed && !searchJobId && leadIds.length === 0) {
    return NextResponse.json(
      { error: "Upload a recipient CSV, pick a Lead Extractor job, or select leads to send to" },
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

  // Recipients come from ONE of three sources (never a blend):
  //   1. an uploaded CSV (existing, unchanged),
  //   2. an explicit list of validated Lead ids (Task 26, Piece 4 — the create
  //      flow's "Pick from my leads" source),
  //   3. a Lead Extractor job's own leads (legacy ?fromSearchJob deep link).
  // Precedence is CSV > leadIds > searchJobId, matching the original "parsed wins"
  // rule. For the lead sources only the email + a few merge variables travel
  // across. Note the deliberate asymmetry: the explicit leadIds path restricts to
  // this user's VALID leads (validation is the whole point — never send to an
  // unchecked/invalid address), while the legacy searchJobId path is untouched and
  // still sends every email-bearing lead, so the deep link keeps its old behavior.
  let recipients: { email: string; variables: Record<string, unknown> }[];
  if (parsed) {
    recipients = parsed.recipients;
  } else if (leadIds.length > 0) {
    // Server-side copy of the picker's filter: only this user's VALID leads are
    // eligible, so a hand-crafted leadId list can't smuggle in a bad address.
    const leads = await prisma.lead.findMany({
      where: { id: { in: leadIds }, userId: session.userId, validationStatus: "valid" },
      select: { email: true, businessName: true, contactName: true, phone: true, website: true },
    });
    const seen = new Set<string>();
    recipients = [];
    for (const l of leads) {
      const r = leadToRecipient(l);
      if (!r || seen.has(r.email.toLowerCase())) continue;
      seen.add(r.email.toLowerCase());
      recipients.push({ email: r.email, variables: r.variables });
    }
    if (recipients.length === 0) {
      return NextResponse.json(
        { error: "None of the selected leads are valid and yours." },
        { status: 400 }
      );
    }
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
  // variant B convert better" analysis and per-send debugging. The indexing lives
  // in the shared lib/campaign-recipients.ts helper so the from-leads add-to-existing
  // route assigns the exact same rotation.
  //
  // Shared, not duplicated: createCampaign() (lib/campaign-create.ts) is the ONE
  // transaction that makes an EmailCampaign + its CampaignVariant rows + its queue
  // roster, and the automation run's send phase already calls it. This route used
  // to inline its own copy of that transaction — two versions that could silently
  // drift — now it only owns the recipient resolution above and hands off the
  // already-resolved list.
  const created = await createCampaign({
    userId: session.userId,
    name,
    mailboxIds,
    variants,
    recipients,
    rotateEvery,
    searchJobId,
  });

  // Response shape kept compatible with the Campaigns page: the frontend reads
  // only data.campaign.id (app/dashboard/campaigns/page.tsx), but we preserve the
  // recipientCount and rowErrors fields the route always returned. createCampaign()
  // returns { campaign: { id }, recipientCount, byMailbox } — the narrower campaign
  // object is all the UI needs (confirmed by grepping POST /api/campaigns usage).
  return NextResponse.json(
    { campaign: created.campaign, recipientCount: created.recipientCount, rowErrors: parsed?.errors ?? [] },
    { status: 201 }
  );
}