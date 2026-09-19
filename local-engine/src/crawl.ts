/**
 * Page-crawl orchestration — TypeScript port of `worker/automation.py`'s
 * `extract_lead_page` (+ the parts of `extract_lead_pdf` that depend only on an
 * injected PDF-text source). It threads together the already-ported extractors,
 * `buildLeads`, and the HTML crawl layer (`src/html.ts`).
 *
 * The actual network/PDF I/O is *injected* via `CrawlDeps`, so this file is fully
 * testable in isolation (pass a fake fetcher) yet usable as-is in the desktop EXE.
 * This is a faithful behavior port of `extract_lead_page`:
 *   - a page that can't be fetched yields zero leads (Task 13: no snippet guesses),
 *   - same-domain contact/about sub-pages are followed (Task 18 deep search),
 *   - embedded-PDF links contribute text only when a `fetchPdfText` is provided,
 *   - the main page's raw HTML is still handed to email extraction for mailto:.
 */
import { extractEmails } from "./extractors/email";
import { extractBusinessName, extractContactNames, extractNamesFromEmail } from "./extractors/name";
import { extractPhones } from "./extractors/phone";
import { buildLeads, type Lead, type SearchResult } from "./lead";
import { findContactLinks, findEmbeddedPdfLinks, htmlToText, CRAWL_USER_AGENT, type Anchor } from "./html";
import { candidateWebmailUrls, detectWebmailPlatform } from "./filters/webmail-platforms";

/** Page/PDF retrieval hooks — injectable so the crawl layer runs in isolation. */
export interface CrawlDeps {
  /** Fetch a page's raw HTML; return "" on ANY failure (unreachable / non-2xx). */
  fetchHtml(url: string, opts?: { userAgent?: string }): Promise<string>;
  /** Optional: PDF URL → extracted page-text. Without it, embedded-PDF following is skipped. */
  fetchPdfText?(url: string): Promise<string>;
}

export interface ExtractLeadPageOptions {
  fetcher: CrawlDeps;
  /** Override _MAX_CONTACT_LINKS_PER_PAGE. */
  contactLinkLimit?: number;
  /** Live "currently doing X" reporting (Task 14 step channel). */
  onStep?: (message: string) => void;
}

export { type Anchor as HtmlAnchor };

/**
 * Fetch one result page and extract email/phone/name metadata as 0..N leads.
 * Ported from extract_lead_page(result, on_step) in automation.py.
 */
export async function extractLeadPage(
  result: SearchResult,
  options: ExtractLeadPageOptions,
): Promise<Lead[]> {
  const { fetcher, contactLinkLimit, onStep } = options;

  const html = await fetcher.fetchHtml(result.url);
  if (!html) {
    // Page unreachable — produce no leads rather than guessing from the snippet.
    return [];
  }

  const combinedTextParts: string[] = [htmlToText(html)];

  // Task 18: follow same-domain contact/about pages.
  const contactLinks = findContactLinks(html, result.url, contactLinkLimit);
  if (onStep && contactLinks.length > 0) {
    onStep(`Found ${contactLinks.length} contact page(s) on ${result.url}`);
  }
  for (const link of contactLinks) {
    if (onStep) onStep(`Visiting contact page: ${link}`);
    const subHtml = await fetcher.fetchHtml(link);
    if (subHtml) combinedTextParts.push(htmlToText(subHtml));
    // One bad sub-page doesn't stop the rest.
  }

  // Task 17: embedded PDF links (only when a PDF-text source is provided).
  if (fetcher.fetchPdfText) {
    for (const pdfUrl of findEmbeddedPdfLinks(html, result.url)) {
      if (onStep) onStep(`Opening PDF: ${pdfUrl}`);
      const pdfText = await fetcher.fetchPdfText(pdfUrl);
      if (pdfText.trim()) {
        if (onStep) onStep(`Extracted ${pdfText.length} characters from PDF`);
        combinedTextParts.push(pdfText);
      }
    }
  }

  const pageText = combinedTextParts.join("\n");

  return leadsFromPageText(result, pageText, html);
}

/**
 * Run the shared post-extraction pipeline (emails/phones/names → leads) on an
 * arbitrary text blob, mirroring the tail of extract_lead_page / extract_lead_pdf.
 * The `html` arg is passed through only for mailto: handling (main page's raw HTML).
 */
export function leadsFromPageText(result: SearchResult, text: string, html = ""): Lead[] {
  // Dedicated extractors — they handle mailto:, junk-domain filtering, and
  // false-extension removal (see extractors/*).
  const emails = extractEmails(text, html);
  const phones = extractPhones(text, html);

  // Best-effort contact name(s): structured patterns first, then email local-parts.
  let contactNames = extractContactNames(text);
  if (emails.length && contactNames.length === 0) {
    contactNames = emails.map(extractNamesFromEmail).filter((n) => n.length > 0);
  }

  return buildLeads(result, emails, phones, contactNames);
}

/**
 * Download a PDF result, extract its text, and produce 0..N leads. Ported from
 * extract_lead_pdf(result): reuses the exact same leadsFromPageText pipeline a page
 * uses — no parallel extraction implementation for PDF text. A PDF that can't be
 * fetched or parsed (corrupt/encrypted/scanned-image-only) yields zero leads.
 * `deps.fetchPdfText` mirrors _fetch_pdf_text (see pdf-text.ts).
 */
export async function extractLeadPdf(
  result: SearchResult,
  deps: { fetchPdfText(url: string): Promise<string> },
): Promise<Lead[]> {
  const pdfText = await deps.fetchPdfText(result.url);
  if (!pdfText.trim()) return [];
  return leadsFromPageText(result, pdfText);
}

/**
 * A default CrawlDeps using the runtime's global `fetch` with the engine's
 * browser User-Agent and a 10s timeout (mirrors REQUEST_TIMEOUT_SECONDS).
 * Returns "" on any failure, matching requests + raise_for_status() semantics.
 */
export function defaultFetcher(userAgent: string = CRAWL_USER_AGENT): CrawlDeps {
  return {
    async fetchHtml(url) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": userAgent },
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return "";
        return await res.text();
      } catch {
        return "";
      }
    },
  };
}

/**
 * SEARCH-mode webmail extraction — TypeScript port of automation.py's
 * extract_webmail_lead. result.url is itself a webmail LOGIN page found via
 * an intitle: dork, not a business directory page — it has no name/email/
 * phone to extract. Fetch it once to CONFIRM the platform (a title-based
 * dork hit alone isn't proof), then produce exactly one lead with the DOMAIN
 * as the actionable result and email/phone/contactName left null. This
 * deliberately breaks from buildLeads' "zero contact info = zero leads"
 * rule: the domain itself (not a guess) IS the lead this mode exists to find.
 */
export async function extractWebmailLead(
  result: SearchResult,
  platformCodes: string[],
  fetcher: CrawlDeps,
  onStep?: (message: string) => void,
): Promise<Lead[]> {
  const html = await fetcher.fetchHtml(result.url);
  if (!html) return [];

  const platform = detectWebmailPlatform(html, platformCodes);
  if (!platform) return [];

  if (onStep) onStep(`Confirmed ${platform} at ${result.url}`);

  let rootDomain = "";
  try {
    rootDomain = new URL(result.url).hostname.replace(/^www\./, "");
  } catch {
    rootDomain = "";
  }
  const businessName = extractBusinessName(result.title, result.url, result.snippet) || rootDomain;

  return [{
    email: null,
    phone: null,
    contactName: null,
    businessName,
    website: rootDomain ? `https://${rootDomain}` : result.url,
    sourceUrl: result.url,
    snippet: `Detected: ${platform} webmail`,
  }];
}

/**
 * VERIFY/PROBE mode — TypeScript port of automation.py's probe_lead_for_webmail.
 * Given a lead already found the normal way (has an email, therefore a
 * domain), actively check a short, bounded list of candidate URLs on that
 * domain for a self-hosted webmail platform. Returns the lead (annotated in
 * `snippet`) if confirmed, else null. Short-circuits on the first confirmed
 * match — real extra network requests per lead.
 */
export async function probeLeadForWebmail(
  lead: Lead,
  platformCodes: string[] | undefined,
  fetcher: CrawlDeps,
): Promise<Lead | null> {
  const email = lead.email ?? "";
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return null;

  for (const url of candidateWebmailUrls(domain)) {
    const html = await fetcher.fetchHtml(url);
    if (!html) continue;
    const platform = detectWebmailPlatform(html, platformCodes);
    if (platform) {
      const note = `Detected: ${platform} webmail`;
      return { ...lead, snippet: lead.snippet ? `${lead.snippet} — ${note}` : note };
    }
  }
  return null;
}