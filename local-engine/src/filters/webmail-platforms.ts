/**
 * Self-hosted webmail platform targeting — TypeScript port of
 * `worker/filters/webmail_platforms.py` (the server's copy). Keep the two in
 * sync; the platform codes/fingerprints must match exactly, since a job's
 * `webmailPlatforms` codes are shared across both pipelines.
 *
 * Two independent modes:
 * 1. SEARCH mode (buildWebmailDorkClause / applyWebmailBiasToQuery): find
 *    webmail LOGIN pages directly via the search engine's own index, using
 *    `intitle:` — same dork-based discovery this app already uses for PDF
 *    roster discovery. Each hit's domain becomes the lead.
 * 2. VERIFY/PROBE mode (candidateWebmailUrls + detectWebmailPlatform): for
 *    leads found the normal way, actively fetch candidate URLs on the lead's
 *    own domain and check for a fingerprint match.
 *
 * Fingerprints sourced from Wappalyzer's open-source technology database
 * (github.com/enthec/webappanalyzer, category 30 "Webmail"), covering the
 * self-hosted platforms.
 *
 * Google Workspace / Microsoft 365 (HOSTED_EMAIL_PROVIDERS below) were
 * originally excluded on the theory that self-hosted webmail was the whole
 * point. Reversed 2026-09-20 on direct owner instruction: real validation
 * (521 confirmed leads, 2026-09-20) showed the self-hosted-only set matches
 * under 2% of US/Canada/Australia business domains — the owner's actual
 * customers are those markets. Detecting these two needs an MX-record
 * lookup, not an HTML fingerprint (they never host a login page on the
 * business's own domain) — see the worker's detect_hosted_email_provider().
 */

export interface WebmailPlatform {
  code: string;
  label: string;
  dorkTitle: string;
  htmlPatterns: RegExp[];
}

export const WEBMAIL_PLATFORMS: Record<string, WebmailPlatform> = {
  roundcube: {
    code: "roundcube",
    label: "RoundCube",
    dorkTitle: "RoundCube Webmail",
    htmlPatterns: [/<title>\s*RoundCube/i, /\brcmail\b/i, /\broundcube\b/i],
  },
  squirrelmail: {
    code: "squirrelmail",
    label: "SquirrelMail",
    dorkTitle: "SquirrelMail",
    htmlPatterns: [/SquirrelMail version/i, /squirrelmail_loginpage_onload/i],
  },
  rainloop: {
    code: "rainloop",
    label: "RainLoop",
    dorkTitle: "RainLoop Webmail",
    htmlPatterns: [/rainloop\/v\/[\d.]+\/static/i, /\brainloop\b/i, /rlAppVersion/i],
  },
  zimbra: {
    code: "zimbra",
    label: "Zimbra",
    dorkTitle: "Zimbra Web Client",
    htmlPatterns: [/Zimbra Web Client/i, /\bzimbraMail\b/i],
  },
  "open-xchange": {
    code: "open-xchange",
    label: "Open-Xchange",
    dorkTitle: "Open-Xchange",
    htmlPatterns: [/open-xchange-appsuite/i, /#io-ox-core/i],
  },
  // Added 2026-09-20 after real probing of 12 live business domains across
  // Nigeria, Kenya, Ghana, the US and the UK: cPanel's own webmail portal
  // (its title/theme selector in front of RoundCube/Horde/SquirrelMail) was
  // the SINGLE MOST COMMON self-hosted webmail wrapper found — 7 of 12 real
  // hits, vs 1 for raw RoundCube (our only prior match). dorkTitle is
  // deliberately weak/noisy here ("Webmail Login" is cPanel's generic page
  // title, shared by countless unrelated products) — this platform's real
  // value is VERIFY/PROBE mode, matched on structural markers instead.
  cpanel: {
    code: "cpanel",
    label: "cPanel Webmail",
    dorkTitle: "Webmail Login",
    htmlPatterns: [/cPanel_magic_revision/i, /\/unprotected\/cpanel\//i],
  },
};

// Hosted providers — MX-record detection, not an HTML fingerprint (see file
// header). Kept separate from WEBMAIL_PLATFORMS since HTML-fingerprint-only
// callers (detectWebmailPlatform) have no way to act on these.
//
// Sourced from Wappalyzer's open dataset (category 75 "Email"), filtered to
// genuine staff-inbox hosting — excludes marketing/transactional senders
// (Mailchimp, Sendgrid, etc.) in that same category, which a business uses
// to SEND from an app, not where staff read mail.
//
// "other-hosted" is the escape hatch: not a named provider, it means "show
// me the real MX host even when it matches none of the named ones" — the
// direct answer to "why manually add each one": any curated list is
// necessarily incomplete, so this surfaces what's actually there instead of
// silently dropping it.
export const HOSTED_EMAIL_PROVIDERS: Record<string, string> = {
  "google-workspace": "Google Workspace",
  "microsoft-365": "Microsoft 365",
  "zoho-mail": "Zoho Mail",
  "icloud-mail": "Apple iCloud Mail",
  "proton-mail": "Proton Mail",
};

// code -> (MX substring, label). Checked in order; first match wins. Zoho's
// pattern is corrected from Wappalyzer's own listed one (a TXT check for
// "transmail.net" — their separate transactional-email product, not Zoho
// Mail's real inbox hosting) — confirmed against zoho.com's own MX records.
export const HOSTED_PROVIDER_MX_PATTERNS: Array<[string, string]> = [
  ["aspmx.l.google.com", "Google Workspace"],
  ["googlemail.com", "Google Workspace"],
  ["outlook.com", "Microsoft 365"],
  ["mail.icloud.com", "Apple iCloud Mail"],
  ["protonmail.ch", "Proton Mail"],
  ["zoho.com", "Zoho Mail"],
];

// Bounded probe candidates — checked in order, stopping at the first
// confirmed match. Deliberately short: adds real wall-clock time per lead.
const CANDIDATE_SUBDOMAINS = ["webmail", "mail"];
const CANDIDATE_PATHS = ["/webmail", "/roundcube"];

export function buildWebmailDorkClause(platformCodes: string[]): string {
  const titles = platformCodes
    .map((code) => WEBMAIL_PLATFORMS[code]?.dorkTitle)
    .filter((t): t is string => Boolean(t));
  const unique = Array.from(new Set(titles));
  if (unique.length === 0) return "";
  const parts = unique.map((t) => `intitle:"${t}"`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/** Mutually exclusive with PDF-biasing — a webmail login page is never a PDF. */
// Confirmed live (2026-09-19) — returns the webmail dork clause ALONE; the
// caller's free-text query is deliberately DROPPED, not appended. This used
// to append the clause to the caller's "find in location" text, which
// produced zero real results: manually tested against real search results, a
// combined query like `law firm in Lagos (intitle:"RoundCube Webmail" OR ...)`
// made the search engine silently drop the intitle: constraints and fall back
// to generic business-search hits. `intitle:"RoundCube Webmail"` ALONE
// reliably returns real, live login pages (confirmed with real samples —
// webmail.digipen.edu, mail.egr.msu.edu, webmail.supremecluster.com, and
// others) — a webmail login page's title has nothing to do with what
// business runs it, so there's no shared text for a combined query to match.
export function applyWebmailBiasToQuery(_query: string, platformCodes: string[]): string {
  return buildWebmailDorkClause(platformCodes);
}

export function detectWebmailPlatform(html: string, platformCodes?: string[]): string | null {
  if (!html) return null;
  const candidates = platformCodes && platformCodes.length > 0
    ? platformCodes.map((c) => WEBMAIL_PLATFORMS[c]).filter((p): p is WebmailPlatform => Boolean(p))
    : Object.values(WEBMAIL_PLATFORMS);
  for (const platform of candidates) {
    for (const pattern of platform.htmlPatterns) {
      if (pattern.test(html)) return platform.label;
    }
  }
  return null;
}

export function candidateWebmailUrls(domain: string): string[] {
  let d = (domain ?? "").trim().toLowerCase();
  if (!d) return [];
  d = d.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  if (!d) return [];
  const urls: string[] = [];
  for (const sub of CANDIDATE_SUBDOMAINS) urls.push(`https://${sub}.${d}/`);
  for (const path of CANDIDATE_PATHS) urls.push(`https://${d}${path}`);
  return urls;
}
