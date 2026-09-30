import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { normalizeLeadEmail, planDuplicateMarks, type LeadEmailRow } from "@/lib/lead-duplicate-plan";

// The RULE — which row is the repeat, and which earlier row it points at — lives
// in lib/lead-duplicate-plan.ts, deliberately import-free so it is unit-testable
// without a database (tests/lead-duplicates.test.ts). Re-exported here so callers
// have a single import for the whole feature.
export { normalizeLeadEmail, planDuplicateMarks } from "@/lib/lead-duplicate-plan";
export type { DuplicateMark, LeadEmailRow } from "@/lib/lead-duplicate-plan";

// TASK_150 T2 — cross-session duplicate leads.
//
// THE BUG THIS EXISTS FOR: Lead's uniqueness is PER JOB
// (@@unique([searchJobId, sourceUrl, email])), so two extraction sessions (two
// SearchJob rows) legitimately store the same address twice. Extraction has no
// knowledge of previous sessions, and POST /api/jobs/[id]/validate only looked
// at `validationStatus: "unchecked"` leads of ITS OWN job — so the second copy
// came back every session and Validate could never remove it.
//
// THE FIX, and the two decisions that matter:
//
//   1. MARK, NEVER DELETE. A lead row can already be referenced by a campaign or
//      an export, so the dedupe writes `validationStatus: "duplicate"` plus
//      `duplicateOfId` (the earlier lead this one repeats) and leaves the row
//      alone. Deleting is a separate, explicit user action
//      (app/api/jobs/[id]/leads/delete-duplicates) that refuses to touch a lead a
//      campaign has used.
//   2. "duplicate" IS NOT "invalid". "invalid" means the MX lookup failed.
//      Folding a duplicate into it would silently corrupt the owner's invalid
//      count and the "Delete N invalid" action would throw away deliverable
//      addresses. Kept strictly separate — this module never writes "invalid",
//      and it never demotes a row that is already "valid"/"invalid" (those carry
//      real MX evidence; re-flagging them would change the counts).
//
// SCOPE: per USER, across ALL that user's jobs, compared case-insensitively on
// the TRIMMED email. Per-job scope *is* the reported bug.
//
// THE TRAP (app/api/leads/upload/route.ts:91-100): `skipDuplicates` does NOT
// collapse rows whose sourceUrl is NULL, because SQL treats every NULL as
// distinct. Uniqueness is never relied on here — every comparison is explicit,
// on lower(btrim(email)) — so a NULL-sourceUrl repeat is caught like any other.

// --- The rule itself lives in lib/lead-duplicate-plan.ts -----------------------
//
// planDuplicateMarks() and normalizeLeadEmail() are imported at the top of this
// file and re-exported. They are deliberately kept in a separate, import-free
// module so the "which row is the repeat" decision can be tested without a
// database — see tests/lead-duplicates.test.ts. Nothing below re-implements it.



/**
 * Marks cross-session duplicates for one user.
 *
 * The seed selects WHICH addresses to look at (so a per-tick call stays bounded
 * instead of scanning the user's whole lead history): either an explicit list of
 * emails (dispatch, right after persisting a batch) or every email in one job
 * (the validate route). The comparison against the user's OTHER jobs is always
 * the full per-user set.
 */
export async function markDuplicateLeads(
  client: PrismaClient | Prisma.TransactionClient,
  opts: { userId: string } & ({ emails: (string | null | undefined)[] } | { jobId: string }),
): Promise<{ marked: number }> {
  let seed: Prisma.Sql;
  if ("jobId" in opts) {
    seed = Prisma.sql`lower(btrim(email)) IN (
      SELECT lower(btrim(email)) FROM "Lead"
      WHERE "searchJobId" = ${opts.jobId} AND email IS NOT NULL AND btrim(email) <> ''
    )`;
  } else {
    const emails = Array.from(
      new Set(opts.emails.map((e) => normalizeLeadEmail(e)).filter((e) => e.length > 0)),
    );
    if (emails.length === 0) return { marked: 0 };
    seed = Prisma.sql`lower(btrim(email)) = ANY(${emails}::text[])`;
  }

  // lower(btrim(email)) rather than an equality on the raw column on purpose:
  // the comparison is case-insensitive on the TRIMMED address, and a NULL
  // sourceUrl must not be able to hide a repeat (see the trap note above).
  const rows = await client.$queryRaw<LeadEmailRow[]>(Prisma.sql`
    SELECT id, email, "createdAt", "validationStatus", "duplicateOfId"
    FROM "Lead"
    WHERE "userId" = ${opts.userId}
      AND email IS NOT NULL
      AND btrim(email) <> ''
      AND ${seed}
  `);

  const plan = planDuplicateMarks(rows);
  if (plan.length === 0) return { marked: 0 };

  const byCanonical = new Map<string, string[]>();
  for (const mark of plan) {
    const ids = byCanonical.get(mark.duplicateOfId);
    if (ids) ids.push(mark.id);
    else byCanonical.set(mark.duplicateOfId, [mark.id]);
  }

  let marked = 0;
  for (const [duplicateOfId, ids] of byCanonical) {
    // The `validationStatus` filter is the guard that makes "MX counts are
    // unchanged" true even under a race: a row that got validated between the
    // SELECT and this UPDATE is left exactly as it is.
    const res = await client.lead.updateMany({
      where: {
        id: { in: ids },
        userId: opts.userId,
        validationStatus: { in: ["unchecked", "duplicate"] },
      },
      data: { validationStatus: "duplicate", duplicateOfId },
    });
    marked += res.count;
  }
  return { marked };
}

/**
 * Counts a job's leads currently marked as duplicates, for the UI pill/count and
 * the validate response's additive fields.
 */
export async function countDuplicateLeads(
  client: PrismaClient | Prisma.TransactionClient,
  opts: { jobId: string; userId: string },
): Promise<number> {
  return client.lead.count({
    where: { searchJobId: opts.jobId, userId: opts.userId, validationStatus: "duplicate" },
  });
}
