/**
 * Merge-variable renderer for the Mailer.
 *
 * A recipient's uploaded-CSV columns are stored per-`EmailQueueItem` in
 * `variables: Json` (e.g. `{ "firstName": "Ada", "company": "ACME" }`). This turns
 * `{{firstName}}`-style placeholders in a variant's subject/bodyHtml into concrete
 * values, applied at send time (not queue time) so editing a template later never
 * requires re-parsing the CSV.
 *
 * Behaviour contract:
 *  - Placeholder syntax is `{{key}}` ONLY. `{{ key }}`, `{{First Name}}` and
 *    `{{first_name}}` are tolerated (whitespace, casing and `_`/`-` separators in
 *    the KEY are cosmetic). `<name>` is NOT a placeholder — it is not a supported
 *    syntax and passes through to the recipient verbatim.
 *  - A missing/empty variable renders to an empty string (never a literal
 *    `{{name}}` and never another recipient's value).
 *  - Leftover placeholders whose key isn't a known variable are also rendered to
 *    an empty string rather than leaking, so a recipient never sees someone
 *    else's data or a raw brace token.
 *
 * WHY MATCHING IS CASE/SEPARATOR-INSENSITIVE (confirmed live 2026-09-30): the two
 * recipient sources store their keys in DIFFERENT shapes —
 *
 *   - a CSV upload lowercases every header (lib/csv.ts `normalizeHeader`), so a
 *     `firstName` column is stored as `firstname`;
 *   - a picked Lead stores camelCase (`contactName`, `businessName` — see
 *     leadToRecipient in lib/campaign-recipients.ts).
 *
 * Under exact-key matching that meant the UI's own documented example
 * (`{{firstName}}`, see the campaign Bodies hint) silently rendered EMPTY for
 * every CSV recipient ("Hi ,") while `{{contactName}}` was the only thing that
 * ever worked for leads — i.e. no single template could address both sources, and
 * the failure mode was a blank instead of an error. Matching now normalises both
 * sides (lowercase, separators stripped), so `{{firstName}}`, `{{firstname}}` and
 * `{{First Name}}` all resolve to the same stored column.
 *
 * A short alias table gives template authors ONE token that works regardless of
 * source: `{{name}}` resolves to the first non-empty of contactName → firstName →
 * businessName. An exactly-named variable always wins over an alias, so a CSV with
 * a literal `name` column is never shadowed.
 */

/** Lowercase, separator-insensitive form used to compare a token with a stored key. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Tokens that resolve to a fallback chain instead of one exact column — so a
 * single template can address a recipient whose source differs (CSV vs Lead).
 * Checked only AFTER an exact/normalized match on a real variable.
 */
const ALIASES: Record<string, string[]> = {
  name: ["contactName", "firstName", "businessName"],
};

/** The first non-empty string among `candidates`, matched the same forgiving way. */
function firstNonEmpty(
  variables: Record<string, string>,
  candidates: string[],
): string | undefined {
  for (const candidate of candidates) {
    const wanted = normalizeKey(candidate);
    for (const [key, value] of Object.entries(variables)) {
      if (normalizeKey(key) !== wanted) continue;
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return undefined;
}

export function renderMerge(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_\- ]+?)\s*\}\}/g, (match, key: string) => {
    // 1. Exact key — the pre-existing behaviour, and what an exactly-named
    //    variable always gets (so an alias can never shadow a real column).
    const exact = variables[key];
    if (typeof exact === "string") return exact;

    const wanted = normalizeKey(key);
    if (!wanted) return "";

    // 2. Same key, different casing/separators (`firstName` == `firstname`).
    for (const [stored, value] of Object.entries(variables)) {
      if (normalizeKey(stored) !== wanted) continue;
      if (typeof value === "string") return value;
    }

    // 3. A built-in alias, resolved against the variables actually present.
    const chain = ALIASES[wanted];
    if (chain) return firstNonEmpty(variables, chain) ?? "";

    return "";
  });
}
