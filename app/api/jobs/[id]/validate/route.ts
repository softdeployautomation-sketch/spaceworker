import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { validateEmailsBatch } from "@/lib/email-validator";

// Task 26, Piece 3 — batch email validation for one job's leads.
// POST /api/jobs/[id]/validate
// Validates every lead in the job that is still "unchecked" (i.e. has an email
// address but hasn't been validated yet): a syntax check plus a DNS MX lookup,
// all with bounded concurrency and a per-domain cache (see lib/email-validator.ts).
// Writes validationStatus/validationError/validatedAt, then returns the tallies.

// Trim to null for empty/blank so we never persist a stray empty string.
function nullOrString(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return null;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Same ownership pattern as the other job routes: an existing job that belongs
  // to someone else reads as 404 (don't leak existence).
  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    select: { id: true },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only leads still awaiting validation. A lead with no email at all can't be
  // validated, so leave those untouched (they stay "unchecked") rather than
  // inventing a failure for a blank address.
  const leads = await prisma.lead.findMany({
    where: { searchJobId: id, userId: session.userId, validationStatus: "unchecked" },
    select: { id: true, email: true },
  });
  const emailLeads = leads.filter((l) => l.email && l.email.trim().length > 0);
  if (emailLeads.length === 0) {
    return NextResponse.json({ valid: 0, invalid: 0, validated: 0, skipped: leads.length });
  }

  const results = await validateEmailsBatch(emailLeads.map((l) => l.email!));

  const validIds: string[] = [];
  const invalidRows: Record<string, string> = {};
  for (let i = 0; i < emailLeads.length; i++) {
    const r = results[i];
    if (r.isValid) validIds.push(emailLeads[i].id);
    else invalidRows[emailLeads[i].id] = r.reason ?? "no_mx_records";
  }
  const invalidIds = Object.keys(invalidRows);
  const validatedAt = new Date();

  // Two bullet updates for the common case (all-valid or all-invalid), plus one
  // per-row update so each lead keeps ITS specific reason rather than a shared one.
  await prisma.$transaction(async (tx) => {
    if (validIds.length > 0) {
      await tx.lead.updateMany({
        where: { id: { in: validIds } },
        data: { validationStatus: "valid", validationError: null, validatedAt },
      });
    }
    if (invalidIds.length > 0) {
      await Promise.all(
        invalidIds.map((lid) =>
          tx.lead.updateMany({
            where: { id: lid },
            data: {
              validationStatus: "invalid",
              validationError: nullOrString(invalidRows[lid]),
              validatedAt,
            },
          }),
        ),
      );
    }
  });

  return NextResponse.json({
    valid: validIds.length,
    invalid: invalidIds.length,
    validated: validIds.length + invalidIds.length,
    // Leads with no email at all are left "unchecked" (nothing to validate) — these
    // are the only ones that skipped, since we validated every email-bearing lead.
    skipped: leads.length - emailLeads.length,
  });
}