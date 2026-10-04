/**
 * TASK_159 — credential detection for support ticket text.
 *
 * WHY THIS FILE EXISTS (PLAN_TASK_159_SUPPORT_TICKETS.md §2.1). Ticket bodies are
 * user-supplied text that gets rendered in an admin UI, mailed, exported, and will
 * one day be searched. The moment a ticket body may contain a raw token, the
 * platform has built a paste-target for its own secrets. That is the rule the whole
 * feature is designed around, so it gets a shared module rather than a regex buried
 * in one route — it is called from BOTH ends:
 *
 *   * the composer, which REDACTs on paste (catches the accident before the data
 *     lands — the plan's stated mechanism), and
 *   * the API, which REJECTs (a backstop, because a direct POST bypasses any UI).
 *
 * They deliberately behave differently. Redacting is right in a text box the user is
 * still editing: it keeps their words and removes only the secret. Rejecting is right
 * at the API: silently storing a body the server has quietly edited would mean the
 * user's own ticket no longer says what they wrote, and they would never be told.
 *
 * WHAT COUNTS AS HIGH-CONFIDENCE, AND WHY THE LIST IS SHORT. This is a floor, not a
 * proof — it will never be a proof, because a secret is just a string. So the goal
 * is ZERO false positives on ordinary prose, and the patterns are chosen for that:
 * every one either names a key ("api_key=", "Bearer"), carries a vendor prefix
 * ("cfut_", "sk_live_", "AKIA"), or is a run that is simultaneously long, mixed-case
 * and underscore-carrying. That last combination is what a Cloudflare token looks
 * like (`cfut__OOujdCztZDuH8yr`) and what ordinary text does not:
 *
 *   * a UUID or a cuid has no underscore        -> never matched
 *   * a snake_case identifier is lowercase-only -> never matched
 *   * a hex hash is lowercase-only              -> never matched
 *   * a file path or a sentence has breaks      -> never matched
 *
 * A user who pastes a real token is therefore told, and a user who writes prose is
 * never interrupted. Tightening this list is always safe; loosening it is not.
 */

/** One named rule, so a rejection can say WHICH shape it saw without echoing it. */
interface CredentialPattern {
  /** Plain-language name, safe to show a user. Never contains the match. */
  label: string;
  pattern: RegExp;
}

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  // An explicit header. "Authorization: Bearer <token>" is the single most common
  // way a token arrives in pasted text, usually inside a curl command.
  { label: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi },

  // A named secret being assigned. `api_key = sk-…`, `CF_API_TOKEN=…`,
  // `"password": "…"`. The KEY name is the tell, so this stays sensitive even when
  // the value is short — which is exactly the case the length heuristics miss.
  //
  // The lookbehind is `(?<![A-Za-z0-9])`, NOT `\b`, and that distinction is load
  // bearing: `\b` does not fire between `_` and `A` (both are word characters), so a
  // `\bapi[_-]?token` prefix would MISS the single most likely real-world spelling,
  // `CF_API_TOKEN=…`. Excluding only alphanumerics still refuses `mypassword=x`.
  {
    label: "a labelled secret (a key name followed by a value)",
    pattern:
      /(?<![A-Za-z0-9])(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|refresh[_-]?token|session[_-]?token|zone[_-]?token|worker[_-]?token|dns[_-]?token|bearer[_-]?token|api[_-]?secret|password|passwd|passphrase)\b\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}/gi,
  },

  // Cloudflare API tokens. The vendor prefix is unambiguous, and the bare form is
  // the long/mixed-case/underscore run described above.
  { label: "a Cloudflare API token", pattern: /\bcf[a-z]{0,4}_[A-Za-z0-9_\-]{20,}/g },
  {
    label: "a Cloudflare API token",
    pattern:
      /\b(?=[A-Za-z0-9_]{30,}\b)(?=[A-Za-z0-9_]*_)(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])[A-Za-z0-9_]{30,}\b/g,
  },

  // Vendor-prefixed keys: these carry their issuer in the prefix, so there is no
  // ambiguity to weigh.
  { label: "a Stripe key", pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "a GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_\-]{30,}\b/g },

  // A JWT is self-identifying: three base64url segments, each of which starts with
  // the same `eyJ` header. Nothing else in ordinary prose looks like this.
  { label: "a JSON Web Token", pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
];

/** What `redactCredentials` replaces a match with. Visible, and obviously not the secret. */
export const REDACTION_PLACEHOLDER = "[removed: looked like a credential]";

/**
 * The first credential-shaped thing in `text`, or `null`.
 *
 * Returns only a plain-language LABEL, never the matched text: this value is shown
 * to the user and may be logged, and echoing the match would defeat the purpose —
 * it would put the secret into the very error message that is keeping it out.
 */
export function describeCredentialIn(text: string): string | null {
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    // `lastIndex` is stateful on a /g regex, so it must be reset before each test or
    // an earlier match would leave the next call skipping ahead and missing.
    pattern.lastIndex = 0;
    if (pattern.test(text)) return label;
  }
  return null;
}

/** Convenience predicate for call sites that only need a yes/no. */
export function looksLikeCredential(text: string): boolean {
  return describeCredentialIn(text) !== null;
}

/**
 * Replace every credential-shaped run with a visible placeholder, leaving the rest
 * of the text byte-for-byte intact. Used by the composer's paste handler.
 *
 * Idempotent: the placeholder contains no credential shape, so running this twice
 * changes nothing further.
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const { pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return out;
}
