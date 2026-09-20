/**
 * Email Extractor — faithful TypeScript port of the production extraction engine's
 * `worker/extractors/email_extractor.py` (the same logic the server-side Python
 * worker has shipped for months). Pure regex string processing: no I/O, no browser,
 * no database — deliberately dependency-free so the desktop EXE and the repo's own
 * test runner (`tsx --test`) can both use it identically.
 *
 * Kept line-for-line behaviorally faithful to the Python original, including the
 * leading-dot local-part recovery (recovered from real extracted output like
 * ".574@hotmail.com" / ".perez@gmail.com") and the junk-domain/prefix/extension
 * filters. Do not "improve" the heuristics here independently — if the Python
 * engine changes, mirror the change here.
 */

// Comprehensive email regex — same character class as the Python original.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Common junk/false-positive emails to filter out.
const JUNK_DOMAINS = new Set([
  "example.com",
  "example.org",
  "test.com",
  "sentry.io",
  "wixpress.com",
  "wordpress.com",
  "w3.org",
  "schema.org",
  "googleapis.com",
  "googleusercontent.com",
  "gstatic.com",
  "facebook.com",
  "twitter.com",
  "instagram.com",
]);

const JUNK_PREFIXES = [
  "noreply",
  "no-reply",
  "mailer-daemon",
  "postmaster",
  "webmaster",
  "abuse",
  "admin@wordpress",
  // Confirmed live 2026-09-20: "example@mysite.com" was saved as a real
  // lead — "example@" is a placeholder prefix regardless of domain.
  "example",
];

// Exact full addresses, not prefix/domain patterns — well-known HTML form
// PLACEHOLDER text that leaks into extracted page text as if real.
// Confirmed live 2026-09-20: "you@email.com" was saved as a real lead.
// "email.com" itself is a real domain (legacy free webmail) so it can't be
// blanket-excluded the way JUNK_DOMAINS entries are — only these specific
// well-known placeholder addresses are.
const JUNK_EMAILS = new Set([
  "you@email.com", "your@email.com", "user@email.com", "name@email.com",
  "email@email.com", "your.email@email.com", "yourname@email.com",
  "youremail@email.com",
]);

// File extensions that look like email TLDs but aren't.
const FALSE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js", ".webp"];

// A 24+ char local-part that's ALL hex characters is virtually never a real
// human email — it's a tracking/session/error-report ID a JS SDK embedded in
// the page (Sentry, analytics, error monitors) formatted email-shaped by
// coincidence. Confirmed live 2026-09-20: a Sentry error-tracking ID was
// saved as a real lead's email. Generic guard, not tied to one vendor's
// domain, since new tracking domains appear constantly.
const HEX_ID_RE = /^[a-f0-9]{24,}$/;

// mailto: link capture — used only on HTML input.
const MAILTO_PATTERN = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;

/**
 * Extract unique email addresses from text and HTML content.
 * Mirrors extract_emails(text, html="") in email_extractor.py.
 */
export function extractEmails(text: string, html = ""): string[] {
  const emails = new Set<string>();

  // Extract from plain text.
  if (text) {
    for (const m of text.matchAll(EMAIL_PATTERN)) emails.add(m[0]);
  }

  // Extract from HTML (especially mailto: links).
  if (html) {
    for (const m of html.matchAll(MAILTO_PATTERN)) emails.add(m[1]);

    // Also search decoded HTML. Python's unquote() is lenient about malformed
    // percent-sequences (it leaves them as-is); decodeURIComponent throws, so
    // guard it to keep behavior aligned with the original.
    let decodedHtml = html;
    try {
      decodedHtml = decodeURIComponent(html);
    } catch {
      decodedHtml = html;
    }
    for (const m of decodedHtml.matchAll(EMAIL_PATTERN)) emails.add(m[0]);
  }

  // Clean and filter.
  const cleaned: string[] = [];
  for (let email of emails) {
    email = email.toLowerCase().trim().replace(/\.+$/, "");
    // A real email's local-part can never start with "." (RFC 5321/5322) —
    // strip leading dots from the local-part specifically (see module docstring).
    if (email.includes("@")) {
      const at = email.indexOf("@");
      const local = email.slice(0, at).replace(/^\.+/, "");
      if (local) email = `${local}@${email.slice(at + 1)}`;
    }

    // Skip known placeholder addresses (see JUNK_EMAILS above).
    if (JUNK_EMAILS.has(email)) continue;

    // Skip junk domains — subdomains too. Confirmed live 2026-09-20: an
    // exact-match-only check missed "sentry-next.wixpress.com" despite
    // "wixpress.com" already being listed, because it's a subdomain. A real
    // subsidiary/regional site at a subdomain of a real business's own
    // domain is not at risk here — every JUNK_DOMAINS entry is third-party
    // platform/tracking infrastructure, never a business's own domain.
    const domain = email.includes("@") ? email.split("@").pop()! : "";
    if (JUNK_DOMAINS.has(domain) || [...JUNK_DOMAINS].some((jd) => domain.endsWith("." + jd))) continue;

    // Skip junk prefixes.
    const prefix = email.includes("@") ? email.split("@")[0] : "";
    if (JUNK_PREFIXES.some((jp) => prefix.startsWith(jp))) continue;

    // Skip machine-generated tracking/session IDs shaped like an email.
    if (HEX_ID_RE.test(prefix)) continue;

    // Skip false extensions (e.g., image@2x.png).
    if (FALSE_EXTENSIONS.some((ext) => email.endsWith(ext))) continue;

    // Basic validation: must have @ and at least one dot after @.
    const host = email.includes("@") ? email.split("@").pop()! : "";
    if (email.includes("@") && host.includes(".")) cleaned.push(email);
  }

  // Sort and deduplicate.
  return [...new Set(cleaned)].sort();
}