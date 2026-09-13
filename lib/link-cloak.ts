// Task 30, item 3 — link-redirect cloaking helpers. Shared by:
//  - lib/campaign-create.ts (creates LinkRedirect rows + rewrites stored bodies at
//    campaign creation, so the mail-queue drain sends the rewritten absolute URL).
//  - The public /r/[token] route is deliberately NOT here — it lives in
//    app/r/[token]/route.ts so the request path is world-readable.
//
// Scope discipline (from the task): the goal is "doesn't visually announce itself
// as a tracking/redirect link", not cryptographic security. A public redirect
// token carries no secret — it's an opaque lookup key. Out of scope: per-click
// timestamps/tables, per-recipient attribution, domain rotation, and automatic
// (non-optional) wrapping.
import "server-only";
import { randomBytes } from "crypto";

// Url-safe opaque token. The token is a lookup key, not a bearer secret, so its
// entropy only needs to make collisions improbable across a small array of links.
export function randomLinkToken(length = 14): string {
  const bytes = randomBytes(length * 2);
  // base64url then strip the padding chars; slice to the requested length.
  return Buffer.from(bytes).toString("base64").replace(/[+/=]/g, "").replace(/-/g, "a").replace(/_/g, "b").slice(0, length);
}

// Matches absolute http(s) URLs. The character class is deliberately permissive
// at the start and trimmed at the tail so we don't chomp off trailing ".", ",",
// or a closing paren/quote that belongs to the surrounding prose, not the href.
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

// Strip trailing punctuation/brackets that hugging the URL's end is prose, not
// part of the destination.
function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "").replace(/[)\]}>]+$/, "");
}

// Unique absolute http(s) URLs contained in a body (or bodies). De-duplicated by
// exact URL. Returns [] for a link-free / plain-text body (the create-modal then
// hides the whole cloaking UI).
export function extractUniqueLinks(...bodies: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    if (!body) continue;
    for (const m of body.matchAll(URL_RE)) {
      const url = cleanUrl(m[0]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export function hasHttpLinks(...bodies: string[]): boolean {
  return extractUniqueLinks(...bodies).length > 0;
}

// Rewrite every absolute http(s) URL in `html` for which `tokenByUrl` has an
// entry into `${baseUrl}/r/<token>`. URLs not in the map are left untouched
// (presentation-only; protects against injecting an un-cloaked url mid-token map).
export function rewriteLinks(html: string, tokenByUrl: Record<string, string>, baseUrl: string): string {
  return html.replace(URL_RE, (m) => {
    const url = cleanUrl(m[0]);
    const token = tokenByUrl[url];
    return token ? `${baseUrl.replace(/\/+$/, "")}/r/${token}` : m;
  });
}

// Assign each unique link a fresh token (used by createCampaign before creating
// LinkRedirect rows and rewriting stored bodies inside the transaction).
export function assignLinkTokens(...bodies: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const url of extractUniqueLinks(...bodies)) {
    map[url] = randomLinkToken();
  }
  return map;
}