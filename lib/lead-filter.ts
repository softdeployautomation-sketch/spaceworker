// TASK_151 (R1/R2) — the recipient picker's include/exclude rule, in ONE place.
//
// WHY THIS MODULE EXISTS: the campaign picker's filter used to be a single
// substring box implemented inline in app/dashboard/campaigns/page.tsx. TASK_151
// turns that into "many include terms OR many exclude terms", and — the part
// that actually matters — excluding must PRUNE the selection, not just hide rows.
// The server send path (POST /api/campaigns) resolves recipients from the
// client's `leadIds`, so the SAME rule has to be enforceable there too; a purely
// client-side filter would be cosmetic (a crafted body could still send to an
// address the UI was showing as excluded).
//
// This module has ZERO imports on purpose: the client picker and the server route
// both import it, and the unit tests load it with the house `require` pattern
// (HOW_WE_MOVE_FAST §4) because a bare `import ... from "../lib/lead-filter.ts"`
// fails `tsc` (the project does not enable allowImportingTsExtensions). See
// lib/test-target.ts for the same pattern and its rationale.

/** The three fields the picker has ALWAYS matched on (app/dashboard/campaigns/page.tsx, pre-TASK_151):
 *  email, businessName, contactName — case-insensitive substring, either field. */
export interface FilterFields {
  email: string | null;
  businessName: string | null;
  contactName: string | null;
}

/** A lead the picker can filter/prune — FilterFields plus identity + owning job. */
export interface FilterableLead extends FilterFields {
  id: string;
  searchJobId?: string;
}

/**
 * Split a raw control value into filter terms.
 *
 * Separators are comma, newline and carriage-return (the minimum TASK_151 §3
 * requires). Spaces are NOT separators — a term like "acme corp" stays one term,
 * which is exactly what the old single box did with that string, so single-term
 * behaviour is unchanged. Terms are trimmed, empties dropped, and de-duplicated
 * case-insensitively (first spelling wins).
 */
export function parseFilterTerms(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw).split(/[,\r\n]+/)) {
    const term = part.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Case-insensitive substring match against email OR businessName OR contactName —
 * the exact rule the old single picker box used. Empty term list never matches
 * (the CALLER decides that "no terms = show everything"; see filterPickerLeads).
 */
export function matchesAnyTerm(lead: FilterFields, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const email = (lead.email ?? "").toLowerCase();
  const business = (lead.businessName ?? "").toLowerCase();
  const contact = (lead.contactName ?? "").toLowerCase();
  return terms.some((t) => {
    const q = t.toLowerCase();
    return email.includes(q) || business.includes(q) || contact.includes(q);
  });
}

/**
 * The picker's visible set: `(job) AND (include OR-terms) AND NOT (exclude terms)`.
 *
 * `excluded` is the count of candidates that passed the job + include filter but
 * were removed by the exclude terms — i.e. "how many rows your exclude just hid",
 * the number the UI surfaces as "N excluded". It is NOT the count of excluded
 * matches in the whole dataset: with a job filter active, only that job's rows are
 * candidates.
 *
 * With `include` empty the behaviour is byte-identical to the pre-TASK_151 single
 * box when it was blank (job filter only). With exactly one include term it is
 * byte-identical to the old non-blank box.
 */
export function filterPickerLeads<T extends FilterableLead>(
  leads: T[],
  opts: { jobId?: string; include?: string[]; exclude?: string[] },
): { visible: T[]; excluded: number } {
  const include = opts.include ?? [];
  const exclude = opts.exclude ?? [];
  const visible: T[] = [];
  let excluded = 0;
  for (const l of leads) {
    if (opts.jobId && l.searchJobId !== opts.jobId) continue;
    if (include.length > 0 && !matchesAnyTerm(l, include)) continue;
    if (exclude.length > 0 && matchesAnyTerm(l, exclude)) {
      excluded++;
      continue;
    }
    visible.push(l);
  }
  return { visible, excluded };
}

/**
 * R2's deliverable: prunes an existing selection so an excluded lead can never
 * remain selected (and therefore can never be sent to). Returns a NEW array; the
 * input is untouched. When there are no exclude terms the SAME reference is
 * returned, so an empty search box causes no state churn (and no render loop) —
 * this is what keeps the "no exclude typed" path identical to today.
 *
 * An id that isn't present in `leads` is KEPT: the picker only ever selects ids
 * it loaded, so an unknown id means our data is stale, and silently dropping a
 * user's selection on stale data is worse than keeping it (the server re-validates
 * ownership/validity regardless).
 */
export function pruneExcludedSelection(
  selectedIds: string[],
  leads: FilterableLead[],
  excludeTerms: string[],
): string[] {
  if (excludeTerms.length === 0) return selectedIds;
  const byId = new Map(leads.map((l) => [l.id, l]));
  return selectedIds.filter((id) => {
    const l = byId.get(id);
    if (!l) return true;
    return !matchesAnyTerm(l, excludeTerms);
  });
}

/** The minimal recipient shape the send path resolves to (lib/campaign-recipients.ts). */
export interface ExcludableRecipient {
  email: string;
  variables?: Record<string, unknown>;
}

/**
 * Server-side guard, R2 item 4. Applied where the selection is CONSUMED
 * (POST /api/campaigns), so an excluded address cannot reach the queue even if a
 * crafted request names its lead id directly — the client's pruning is a
 * convenience, this is the enforcement. Reconstructs the same three match fields
 * the picker uses: the address itself plus the merge variables the lead source
 * carries (businessName/contactName). No exclude terms => the SAME array is
 * returned (zero behavioural change for every other recipient source).
 */
export function excludeRecipients<T extends ExcludableRecipient>(
  recipients: T[],
  excludeTerms: string[],
): { recipients: T[]; excludedCount: number } {
  if (excludeTerms.length === 0) return { recipients, excludedCount: 0 };
  const kept = recipients.filter((r) => {
    const vars = r.variables ?? {};
    const fields: FilterFields = {
      email: r.email,
      businessName: typeof vars.businessName === "string" ? vars.businessName : null,
      contactName: typeof vars.contactName === "string" ? vars.contactName : null,
    };
    return !matchesAnyTerm(fields, excludeTerms);
  });
  return { recipients: kept, excludedCount: recipients.length - kept.length };
}

