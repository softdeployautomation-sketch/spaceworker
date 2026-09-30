import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { normalizeLeadEmail } from "@/lib/lead-duplicates";

// TASK_150 T2 — discard the duplicates in a job after a dedupe pass.
// POST /api/jobs/[id]/leads/delete-duplicates
//
// Modelled on the delete-invalid route (same ownership pattern, same shape), with
// ONE added guard: a lead a campaign has actually sent to (or queued) is REFUSED.
// A duplicate row is the repeat of an address the user already had earlier, so
// removing it is normally safe — the canonical row stays — but "the same
// address" is not "the same recipient record": a campaign's queue rows record
// what was sent, and this route must not quietly remove the lead a user is
// looking at in a campaign. So it refuses the whole request with 409 and deletes
// NOTHING, rather than partially deleting and reporting success.
//
// "Referenced by a campaign" is detected on the real recipient record, not on
// EmailCampaign.searchJobId: a campaign is created from a job's VALIDATED leads,
// and a duplicate (by construction) was never eligible for that selection, so
// the job link alone means nothing. EmailQueueItem.toEmail is the actual
// recipient, and it is compared case-insensitively on the trimmed address, the
// same rule the dedupe itself uses.
//
// Deletes are scoped to THIS job's duplicates and this user, so the canonical
// (earlier) row is never touched here.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Same ownership pattern as the other job routes: a job that belongs to
  // someone else reads as 404 (don't leak existence).
  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    select: { id: true },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const duplicates = await prisma.lead.findMany({
    where: { searchJobId: id, userId: session.userId, validationStatus: "duplicate" },
    select: { id: true, email: true },
  });
  if (duplicates.length === 0) {
    return NextResponse.json({ deleted: 0, blocked: 0, blockedLeads: [] });
  }

  const emails = Array.from(
    new Set(duplicates.map((l) => normalizeLeadEmail(l.email)).filter((e) => e.length > 0)),
  );

  // Which of those addresses is a real recipient on one of this user's
  // campaigns? Raw SQL because the comparison is lower(btrim(toEmail)) — the
  // stored toEmail is whatever the source lead/CSV carried, so an exact match
  // would miss a casing difference and let a used lead through.
  const referenced = emails.length === 0 ? [] : await prisma.$queryRaw<
    { email: string; campaignId: string; campaignName: string }[]
  >(Prisma.sql`
    SELECT DISTINCT lower(btrim(q."toEmail")) AS "email", c."id" AS "campaignId", c."name" AS "campaignName"
    FROM "EmailQueueItem" q
    JOIN "EmailCampaign" c ON c."id" = q."campaignId"
    WHERE c."userId" = ${session.userId}
      AND lower(btrim(q."toEmail")) = ANY(${emails}::text[])
  `);

  if (referenced.length > 0) {
    const blockedEmails = Array.from(new Set(referenced.map((r) => r.email)));
    return NextResponse.json(
      {
        error:
          "These duplicates are already recipients on a campaign, so they were not deleted. " +
          "Remove them from the campaign first if you really mean to.",
        deleted: 0,
        blocked: blockedEmails.length,
        blockedLeads: referenced,
      },
      { status: 409 },
    );
  }

  const deleted = await prisma.lead.deleteMany({
    where: { id: { in: duplicates.map((l) => l.id) }, userId: session.userId },
  });

  return NextResponse.json({ deleted: deleted.count, blocked: 0, blockedLeads: [] });
}
