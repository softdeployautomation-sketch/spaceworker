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
 * (github.com/enthec/webappanalyzer, category 30 "Webmail"), restricted to
 * the self-hosted platforms — Google Workspace / Microsoft 365 / Proton Mail
 * / iCloud Mail are deliberately excluded.
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
};

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
export function applyWebmailBiasToQuery(query: string, platformCodes: string[]): string {
  const clause = buildWebmailDorkClause(platformCodes);
  const q = (query ?? "").trim();
  if (!clause) return q;
  return q ? `${q} ${clause}`.trim() : clause;
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
