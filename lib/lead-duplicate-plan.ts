// TASK_150 T2 — the pure, DB-free half of the cross-session duplicate rule.
//
// Deliberately ZERO imports (the house pattern — see lib/test-target.ts) so the
// rule is unit-testable without a database, Prisma, or the production
// environment. lib/lead-duplicates.ts is the DB half (it SELECTs a user's leads,
// calls planDuplicateMarks, and writes the markers); this file only decides.
//
// WHY sourceUrl IS NOT AN INPUT: uniqueness in the database is
// @@unique([searchJobId, sourceUrl, email]), and `skipDuplicates` does NOT
// collapse rows whose sourceUrl is NULL — SQL treats every NULL as distinct
// (documented at app/api/leads/upload/route.ts:91-100). So this planner never
// consults sourceUrl, and therefore cannot be fooled by a NULL repeat; the
// comparison is only ever the normalised email.

/** A lead row as the planner needs it. `email` may be null (nothing to dedupe). */
export interface LeadEmailRow {
  id: string;
  email: string | null;
  createdAt: Date;
  validationStatus: string | null;
  duplicateOfId?: string | null;
}

/** One row that must be (re)written to point at its canonical earlier lead. */
export interface DuplicateMark {
  id: string;
  duplicateOfId: string;
}

/** The one normalisation rule, in one place: trimmed + lowercased, "" for none. */
export function normalizeLeadEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Decides which rows are duplicates and which earlier row each one repeats.
 *
 * Canonical selection within one normalised email, in priority order:
 *   1. the earliest "valid" row   (a row with real MX evidence wins, so an
 *      unvalidated repeat is the one flagged rather than a good row);
 *   2. else the earliest "invalid" row (also real evidence — never demoted);
 *   3. else the earliest row by (createdAt, id).
 * Every OTHER row is flagged unless it is already "valid"/"invalid", which are
 * never rewritten. Idempotent: an already-correct duplicate produces no mark.
 */
export function planDuplicateMarks(rows: LeadEmailRow[]): DuplicateMark[] {
  const groups = new Map<string, LeadEmailRow[]>();
  for (const row of rows) {
    const key = normalizeLeadEmail(row.email);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const marks: DuplicateMark[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    // Stable ordering: createdAt, then id — a tie on the timestamp must not make
    // the canonical pick depend on the query's row order.
    const ordered = [...bucket].sort((a, b) => {
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const canonical =
      ordered.find((r) => r.validationStatus === "valid") ??
      ordered.find((r) => r.validationStatus === "invalid") ??
      ordered[0];
    for (const row of ordered) {
      if (row.id === canonical.id) continue;
      // Never demote a row that carries MX evidence — that is what keeps the
      // valid/invalid tallies untouched by a dedupe pass.
      if (row.validationStatus === "valid" || row.validationStatus === "invalid") continue;
      // Already exactly right — don't issue a no-op write.
      if (row.validationStatus === "duplicate" && row.duplicateOfId === canonical.id) continue;
      marks.push({ id: row.id, duplicateOfId: canonical.id });
    }
  }
  return marks;
}
