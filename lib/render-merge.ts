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
 *  - Placeholder syntax is `{{key}}` OR the equivalent `((key))` alias, each with
 *    an OPTIONAL default: `{{key|fallback}}` / `((key|fallback))` renders the
 *    fallback when nothing resolves. Whitespace, casing and `_`/`-` separators in
 *    the KEY are cosmetic (`{{ First Name }}` == `{{firstName}}`).
 *  - A token is NEVER shown literally to a recipient: an unknown `{{…}}` renders
 *    to an empty string, and `((…))` only acts as a token for the known
 *    name/email key set (PAREN_TOKEN_KEYS) — any OTHER `((…))` passes through
 *    untouched, so literal parenthetical text already in a body can never be
 *    eaten. `<name>` is NOT a placeholder — it passes through verbatim.
 *  - A missing/empty variable renders to an empty string (never a literal
 *    `{{name}}` and never another recipient's value).
 *
 * TASK_234 — NAME DERIVED FROM THE EMAIL ADDRESS ALONE: when the variables carry
 * no name, the name keys fall back to `opts.email` parsed from its local part
 * (jane.smith@x.com → Jane; info@x.com is a role address → nothing → default or
 * empty). So `((name))` / `{{name}}` work with NOTHING but the recipient's
 * address and never depend on extractor/CSV name columns. An exact or
 * alias-resolved variable ALWAYS wins over the email-derived value — email is
 * only the fallback source, never a replacement for real data.
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

/**
 * Keys whose value may be derived from the recipient's EMAIL ADDRESS when the
 * variables carry none (TASK_234). Normalized form.
 */
const NAME_KEYS = new Set(["name", "firstname", "fullname", "contactname"]);

/**
 * The `((key))` form only acts as a placeholder for this known set — every other
 * `((…))` is passed through untouched so literal parenthetical text in existing
 * bodies is never eaten by the newer syntax. Normalized form. Deliberately
 * covers the owner's headline token `((name))` plus its variants and the tokens
 * users already know from `{{…}}`.
 */
const PAREN_TOKEN_KEYS = new Set([
  "name",
  "firstname",
  "fullname",
  "contactname",
  "email",
  "company",
  "businessname",
]);

/**
 * Local parts that are MAILBOX ROLE ADDRESSES, not people — deriving "Hi Info"
 * from info@acme.com is worse than the documented fallback, so these are skipped
 * and the token falls through to its default/empty rendering.
 */
const ROLE_LOCAL_PARTS = new Set([
  "info", "support", "sales", "admin", "administrator", "hello", "contact",
  "office", "noreply", "donotreply", "team", "help", "service", "billing",
  "account", "accounts", "marketing", "jobs", "careers", "press", "media",
  "abuse", "postmaster", "webmaster", "privacy", "mail", "email", "inbox",
  "reception", "hr", "staff", "orders", "shop", "store", "customer",
  "customers", "success", "growth", "partners", "legal", "finance",
  "accounting", "enquiries", "inquiries", "query", "queries", "questions",
  "editor", "autoresponder", "bounce", "newsletter",
]);

/**
 * A person's first name parsed from an email address — the same trick GMass
 * ("detect a person's first name from just an email address") uses: split the
 * local part on `.`/`_`/`-`, drop `+tag` suffixes, trailing digits and
 * single-letter segments (j.smith → smith), skip role addresses, title-case the
 * first usable segment. Returns "" when nothing usable is found — the caller
 * then uses the token's default or an empty string, never the raw token.
 */
function nameFromEmail(email: string | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return "";
  const local = email.slice(0, at).toLowerCase();
  const base = local.split("+")[0] ?? "";
  for (const raw of base.split(/[._\-]/)) {
    const seg = raw.replace(/[0-9]+$/, ""); // alex99@ → alex
    if (seg.length < 2 || /^[0-9]/.test(seg)) continue;
    const normalized = normalizeKey(seg);
    if (!normalized || ROLE_LOCAL_PARTS.has(normalized)) continue;
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }
  return "";
}

/** Optional per-call context beyond the stored variables (TASK_234). */
export interface RenderMergeOptions {
  /**
   * The recipient's email address — the fallback source for the name keys when
   * the variables carry no name, and what `{{email}}` renders for a recipient
   * with no stored email column.
   */
  email?: string;
}

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

/**
 * Resolve one token key against the variables, then (TASK_234) against the
 * recipient's email. `found: false` means nothing at all resolved — the caller
 * then uses the token's default (if written) or an empty string, except for an
 * unknown `((…))`, which passes through untouched instead.
 */
function resolveToken(
  key: string,
  variables: Record<string, string>,
  opts: RenderMergeOptions | undefined,
): { value: string; found: boolean } {
  // 1. Exact key — the pre-existing behaviour, and what an exactly-named
  //    variable always gets (so an alias can never shadow a real column).
  const exact = variables[key];
  if (typeof exact === "string") return { value: exact, found: true };

  const wanted = normalizeKey(key);
  if (!wanted) return { value: "", found: true }; // "{{ }}" — as before, empty

  // 2. Same key, different casing/separators (`firstName` == `firstname`).
  for (const [stored, value] of Object.entries(variables)) {
    if (normalizeKey(stored) !== wanted) continue;
    if (typeof value === "string") return { value, found: true };
  }

  // 3. A built-in alias, resolved against the variables actually present.
  const chain = ALIASES[wanted];
  if (chain) {
    const aliased = firstNonEmpty(variables, chain);
    if (aliased !== undefined) return { value: aliased, found: true };
  }

  // 4. TASK_234 — derive from the EMAIL ADDRESS alone, so personalization never
  //    depends on an extractor/CSV name column. Variables above always win.
  if (wanted === "email" && opts?.email) return { value: opts.email, found: true };
  if (NAME_KEYS.has(wanted)) {
    const derived = nameFromEmail(opts?.email);
    if (derived) return { value: derived, found: true };
  }

  return { value: "", found: false };
}

/** Shared token replacement for both syntaxes (see renderMerge's contract above). */
function replaceToken(
  match: string,
  key: string,
  fallback: string | undefined,
  variables: Record<string, string>,
  opts: RenderMergeOptions | undefined,
  parenSyntax: boolean,
): string {
  // Unknown `((…))` is NOT a placeholder — pass the original text through so a
  // body containing literal double-parentheses is never altered.
  if (parenSyntax && !PAREN_TOKEN_KEYS.has(normalizeKey(key))) return match;
  const { value, found } = resolveToken(key, variables, opts);
  if (found) return value;
  return fallback ?? "";
}

export function renderMerge(
  template: string,
  variables: Record<string, string>,
  opts?: RenderMergeOptions,
): string {
  // `{{…}}` — the classic syntax (unknown keys render empty, never raw).
  const withCurly = template.replace(
    /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g,
    (match, key: string, fallback?: string) =>
      replaceToken(match, key, fallback, variables, opts, false),
  );
  // `((…))` — the paren alias the owner's reference sender used; only the known
  // key set inside replaceToken acts as a token, everything else passes through.
  return withCurly.replace(
    /\(\(\s*([^()|]+?)\s*(?:\|\s*([^()]*?)\s*)?\)\)/g,
    (match, key: string, fallback?: string) =>
      replaceToken(match, key, fallback, variables, opts, true),
  );
}
