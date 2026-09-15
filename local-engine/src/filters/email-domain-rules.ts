/**
 * Email domain allowlist / site: restriction for search + export — TypeScript port
 * of `worker/filters/email_domain_rules.py`.
 *
 * Design (industry-typical):
 * - **Search `site:`** — limits the search engine to pages on those hosts.
 * - **Email domain allowlist** — after extraction, keep only leads where at least
 *   one address in the email field matches.
 *
 * Syntax (one rule per line, commas also split):
 *   gmail.com          → matches user@gmail.com (and subdomains like user@mail.gmail.com)
 *   @yahoo.com         → same
 *   *.edu              → any domain ending in .edu
 *   .gov               → same as *.gov
 *
 * Lines starting with # are comments. Empty lines ignored.
 */
import { normalizeEmailCellToAddresses } from "../utils/email-normalize";

// Reasonable hostname for site: / exact domain rules (no path, no port).
const _DOMAIN_LABEL = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
const _DOMAIN_RE = new RegExp(`^${_DOMAIN_LABEL}(?:\\.${_DOMAIN_LABEL})+$`, "i");

function _stripComment(line: string): string {
  if (line.includes("#")) line = line.split("#", 2)[0];
  return line.trim();
}

function _splitLinesAndCommas(text: string | null): string[] {
  if (!text || !String(text).trim()) return [];
  const parts: string[] = [];
  for (const line of String(text).split(/\r?\n/)) {
    const lineClean = _stripComment(line);
    if (!lineClean) continue;
    for (const chunk of lineClean.split(",")) {
      const t = chunk.trim();
      if (t) parts.push(t);
    }
  }
  return parts;
}

/** Lowercase host token without scheme/path; undefined if invalid. */
export function normalizeDomainToken(raw: string): string | undefined {
  let t = (raw ?? "").trim().toLowerCase();
  if (!t) return undefined;
  if (t.startsWith("@")) t = t.slice(1);
  t = t.trim().replace(/^\.+|\.+$/g, "");
  // Strip accidental URL prefix.
  for (const prefix of ["http://", "https://", "//"]) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length).split("/")[0].split(":")[0];
      break;
    }
  }
  if (!t || !t.includes(".")) return undefined;
  if (!_DOMAIN_RE.test(t)) return undefined;
  return t;
}

export interface EmailDomainRules {
  /** Exact / subdomain rules. */
  exactDomains: string[];
  /** Suffix rules (*.edu). */
  suffixes: string[];
}

export function isEmptyRules(rules: EmailDomainRules): boolean {
  return rules.exactDomains.length === 0 && rules.suffixes.length === 0;
}

/**
 * Parse textarea / setting string into rules.
 * *.suffix or .suffix → suffix match on the email host (e.g. *.edu).
 * Mirrors parse_email_domain_allowlist(text).
 */
export function parseEmailDomainAllowlist(text: string | null): EmailDomainRules {
  const exact: string[] = [];
  const suffixes: string[] = [];
  const seenE = new Set<string>();
  const seenS = new Set<string>();
  for (const raw of _splitLinesAndCommas(text)) {
    const r = raw.trim().toLowerCase();
    if (r.startsWith("*.") && r.length > 2) {
      const suf = r.slice(2).trim().replace(/^\.+|\.+$/g, "");
      if (suf && !seenS.has(suf)) {
        seenS.add(suf);
        suffixes.push(suf);
      }
      continue;
    }
    if (r.startsWith(".") && r.length > 1) {
      const suf = r.slice(1).trim().replace(/^\.+|\.+$/g, "");
      if (suf && !seenS.has(suf)) {
        seenS.add(suf);
        suffixes.push(suf);
      }
      continue;
    }
    const d = normalizeDomainToken(raw);
    if (d && !seenE.has(d)) {
      seenE.add(d);
      exact.push(d);
    }
  }
  return { exactDomains: exact, suffixes };
}

function _hostMatchesExact(emailHost: string, domain: string): boolean {
  const h = emailHost.toLowerCase().trim().replace(/\.+$/g, "");
  const d = domain.toLowerCase().trim().replace(/\.+$/g, "");
  return h === d || h.endsWith("." + d);
}

function _hostMatchesSuffix(emailHost: string, suffix: string): boolean {
  const h = emailHost.toLowerCase().replace(/\.+$/g, "");
  const s = suffix.toLowerCase().trim().replace(/^\.+/g, "");
  if (!s) return false;
  return h === s || h.endsWith("." + s);
}

export function emailMatchesRules(emailAddress: string, rules: EmailDomainRules): boolean {
  if (isEmptyRules(rules) || !emailAddress || !emailAddress.includes("@")) return false;
  const host = emailAddress.slice(emailAddress.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.+$/g, "");
  if (!host) return false;
  for (const d of rules.exactDomains) {
    if (_hostMatchesExact(host, d)) return true;
  }
  for (const s of rules.suffixes) {
    if (_hostMatchesSuffix(host, s)) return true;
  }
  return false;
}

export function leadRowMatchesEmailRules(lead: { email?: string | null }, rules: EmailDomainRules): boolean {
  if (isEmptyRules(rules)) return true;
  const addrs = normalizeEmailCellToAddresses(lead.email ?? null);
  if (addrs.length === 0) return false;
  return addrs.some((a) => emailMatchesRules(a, rules));
}

/**
 * Drop leads that do not match rules. If rules empty, return leads unchanged.
 * Mirrors filter_leads_by_email_domains(leads, rules) → (kept, dropped).
 */
export function filterLeadsByEmailDomains(
  leads: Array<{ email?: string | null }>,
  rules: EmailDomainRules | null,
): { kept: Array<{ email?: string | null }>; dropped: number } {
  if (leads.length === 0) return { kept: [], dropped: 0 };
  if (rules === null || isEmptyRules(rules)) return { kept: [...leads], dropped: 0 };
  const kept: Array<{ email?: string | null }> = [];
  let dropped = 0;
  for (const row of leads) {
    if (leadRowMatchesEmailRules(row, rules)) kept.push(row);
    else dropped += 1;
  }
  return { kept, dropped };
}

// Users often enter the *search engine* or a social app here. site:google.com does
// NOT mean "search with Google" — it means "only pages whose URL is on google.com".
const _SITE_HOST_SEARCH_AND_SOCIAL_PORTALS = new Set([
  "google.com",
  "gstatic.com",
  "googleusercontent.com",
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "instagram.com",
  "threads.net",
  "twitter.com",
  "x.com",
  "t.co",
  "linkedin.com",
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "msn.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "snapchat.com",
]);

function _registrableRootForPortalCheck(hostname: string): string {
  let h = (hostname ?? "").trim().toLowerCase().replace(/\.+$/g, "");
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

function _isBlockedSearchPortalDomain(hostname: string): boolean {
  const root = _registrableRootForPortalCheck(hostname);
  if (_SITE_HOST_SEARCH_AND_SOCIAL_PORTALS.has(root)) return true;
  // e.g. mail.google.com, apis.google.com
  for (const portal of ["google.com", "facebook.com", "yahoo.com", "bing.com"]) {
    if (root === portal || root.endsWith("." + portal)) return true;
  }
  return false;
}

/**
 * Domains for the site: operator. Ignores *.wildcard-only lines (not valid for site:).
 * Returns { acceptedDomains, skippedPortalDomains }. Portal/social/search domains
 * are skipped because they almost never host the PDF rosters this app looks for.
 */
export function parseSiteDomainsForSearch(
  text: string | null,
): { acceptedDomains: string[]; skippedPortalDomains: string[] } {
  const out: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const seenSkip = new Set<string>();
  for (const raw of _splitLinesAndCommas(text)) {
    const r = raw.trim().toLowerCase();
    if (r.startsWith("*.") || (r.startsWith(".") && r.length > 1)) continue;
    const d = normalizeDomainToken(raw);
    if (!d || seen.has(d) || seenSkip.has(d)) continue;
    if (_isBlockedSearchPortalDomain(d)) {
      seenSkip.add(d);
      skipped.push(d);
      continue;
    }
    seen.add(d);
    out.push(d);
  }
  return { acceptedDomains: out, skippedPortalDomains: skipped };
}

/** Build (site:a OR site:b) from normalized host list. */
export function domainsToSiteClause(domains: string[]): string {
  if (!domains || domains.length === 0) return "";
  const parts = domains.map((d) => `site:${d}`);
  if (parts.length === 1) return parts[0];
  return `(${parts.join(" OR ")})`;
}

export function buildSiteRestrictionClause(siteDomainsText: string | null): string {
  const { acceptedDomains } = parseSiteDomainsForSearch(siteDomainsText);
  return domainsToSiteClause(acceptedDomains);
}

/** Returns { siteClause, skippedPortalDomains, acceptedDomains } for automation + messaging. */
export function prepareSiteRestrictionForAutomation(
  siteDomainsText: string | null,
): { siteClause: string; skippedPortalDomains: string[]; acceptedDomains: string[] } {
  const { acceptedDomains, skippedPortalDomains } = parseSiteDomainsForSearch(siteDomainsText);
  return {
    siteClause: domainsToSiteClause(acceptedDomains),
    skippedPortalDomains,
    acceptedDomains,
  };
}

/** Append site: restriction without dropping user's keywords. */
export function applySiteRestrictionToQuery(query: string, siteClause: string): string {
  const q = (query ?? "").trim();
  if (!siteClause) return q;
  if (!q) return siteClause;
  return `(${q}) ${siteClause}`.trim();
}

// Hosts where forcing filetype:pdf on every query almost always yields empty SERPs.
function _isPdfRareSiteHost(normalizedDomain: string): boolean {
  const d = (normalizedDomain ?? "").trim().toLowerCase().replace(/\.+$/g, "");
  if (!d) return false;
  if (d === "redd.it" || d.endsWith(".redd.it")) return true;
  if (d === "reddit.com" || d.endsWith(".reddit.com")) return true;
  return false;
}

/** True when every accepted site: host is PDF-rare (e.g. only Reddit). */
export function siteRestrictionTargetsOnlyPdfRareHosts(acceptedDomains: string[]): boolean {
  if (!acceptedDomains || acceptedDomains.length === 0) return false;
  return acceptedDomains.every((x) => _isPdfRareSiteHost(x));
}