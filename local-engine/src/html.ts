/**
 * HTML page-crawl layer — dependency-free TypeScript port of the HTML parsing /
 * link-discovery helpers in `worker/automation.py` (`_find_contact_links`,
 * `_find_embedded_pdf_links`, `_absolute_url`, `_decode_ddg_url`, and the
 * `soup.get_text(" ", strip=True)` / `soup.find_all("a", href=True)` page reads
 * that power `extract_lead_page`).
 *
 * The Python original uses BeautifulSoup + lxml; this module provides the same
 * *capabilities* with a small self-contained HTML scanner (no external parser,
 * so the desktop EXE and the repo's `tsx --test` can both run it with zero
 * extra runtime dependencies). It is the parsing/crawl-decision layer only —
 * actually fetching pages/PDFs is injected by the caller (see `src/crawl.ts`).
 */

// MAX_CONTACT_LINKS_PER_PAGE=5 / _MAX_CONTACT_LINKS_PER_PAGE (Python default).
export const MAX_CONTACT_LINKS_PER_PAGE = 5;
// _MAX_EMBEDDED_PDFS_PER_PAGE=3 (Python default).
export const MAX_EMBEDDED_PDFS_PER_PAGE = 3;

// _CONTACT_LINK_KEYWORDS from automation.py — same list verbatim (deduplicated).
export const CONTACT_LINK_KEYWORDS = [
  "contact",
  "about",
  "team",
  "staff",
  "people",
  "leadership",
  "our-team",
  "about-us",
  "contact-us",
  "get-in-touch",
  "meet",
  "directory",
  "management",
  "who-we-are",
];

// Lowercased tag names whose text is treated as noise and skipped (not part of the
// page's extractable contact text). Soup.get_text would include these; dropping
// script/style/noscript/head keeps the extraction blob clean without affecting
// the mailto:/ph v extraction the engine depends on.
const SKIP_TEXT_TAGS = new Set(["script", "style", "noscript", "head", "template"]);

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── URL helpers ─────────────────────────────────────────────────────────

/** Resolve a possibly-relative URL against a base. Mirrors _absolute_url(). */
export function absoluteUrl(maybeRelative: string, base: string): string {
  if (maybeRelative.startsWith("http://") || maybeRelative.startsWith("https://")) {
    return maybeRelative;
  }
  if (maybeRelative.startsWith("//")) {
    return "https:" + maybeRelative;
  }
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

/** Hostname (lowercased, no port) of a URL, mirrored to _absolute_url's netloc check. */
export function netlocOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Decode a DuckDuckGo redirect href into the real destination URL.
 * Mirrors _decode_ddg_url().
 */
export function decodeDdgUrl(href: string): string {
  if (href.includes("uddg=") && href.includes("?")) {
    const qs = new URLSearchParams(href.split("?")[1]);
    const encoded = qs.get("uddg");
    if (encoded && (encoded.startsWith("http://") || encoded.startsWith("https://"))) {
      return encoded;
    }
  }
  return href;
}

// ── HTML entity decoding (small, safe subset) ───────────────────────────

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(str: string): string {
  // Fast path — no '&' at all.
  if (!str.includes("&")) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
    if (code[0] === "#") {
      if (code[1] === "x" || code[1] === "X") {
        const n = parseInt(code.slice(2), 16);
        return Number.isNaN(n) ? full : String.fromCodePoint(n);
      }
      const n = parseInt(code.slice(1), 10);
      return Number.isNaN(n) ? full : String.fromCodePoint(n);
    }
    const key = code.toLowerCase();
    return key in ENTITY_MAP ? ENTITY_MAP[key] : full;
  });
}

// ── HTML scanner (dependency-free stand-in for BeautifulSoup + lxml) ────────

export interface Anchor {
  href: string;
  text: string;
}

interface Tag {
  closing: boolean;
  name: string;
  attrs: Record<string, string>;
  special: boolean; // comment / doctype / processing instruction — inert
  endIndex: number; // index just past the closing ">"
}

/** Parse one tag starting at html[i] (must be '<'). Returns null for non-tags. */
function parseTag(html: string, i: number): Tag | null {
  let j = i + 1;
  let closing = false;
  if (html[j] === "/") {
    closing = true;
    j++;
  }
  while (j < html.length && /\s/.test(html[j])) j++;

  // Comments / doctype / processing instructions → inert, consume up to '>'.
  if (!closing && (html[j] === "!" || html[j] === "?")) {
    if (html.slice(j, j + 4) === "!--") {
      const end = html.indexOf("-->", j);
      return { closing: false, name: "", attrs: {}, special: true, endIndex: end === -1 ? html.length : end + 3 };
    }
    const end = html.indexOf(">", j);
    return { closing: false, name: "", attrs: {}, special: true, endIndex: end === -1 ? html.length : end + 1 };
  }

  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(j));
  if (!nameMatch) return null; // e.g. "<3" or "< " — not a real tag; treat "<" literal.
  const name = nameMatch[0].toLowerCase();
  j += nameMatch[0].length;

  const attrs: Record<string, string> = {};
  while (j < html.length) {
    while (j < html.length && /\s/.test(html[j])) j++;
    if (j >= html.length || html[j] === ">") break;
    if (html[j] === "/") {
      j++; // self-closing '/>' — next should be '>'
      continue;
    }
    const am = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*/.exec(html.slice(j));
    if (!am) {
      j++;
      continue;
    }
    const attrName = am[0].toLowerCase();
    j += am[0].length;

    let value = "";
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] === "=") {
      j++;
      while (j < html.length && /\s/.test(html[j])) j++;
      if (html[j] === '"' || html[j] === "'") {
        const q = html[j];
        j++;
        const start = j;
        while (j < html.length && html[j] !== q) j++;
        value = html.slice(start, j);
        if (j < html.length) j++; // skip closing quote
      } else {
        const start = j;
        while (j < html.length && !/\s/.test(html[j]) && html[j] !== ">") j++;
        value = html.slice(start, j);
      }
    }
    // Attribute present (boolean attr → value ""), stored.
    attrs[attrName] = decodeEntities(value);
  }

  const endIndex = j < html.length && html[j] === ">" ? j + 1 : j;
  return { closing, name, attrs, special: false, endIndex };
}

/**
 * Single pass over HTML producing cleaned top-level text chunks and all <a href>
 * anchors (with their inner text), skipping script/style/noscript/head/template.
 * Mirrors what extract_lead_page needs from `soup.get_text(" ", strip=True)` and
 * `soup.find_all("a", href=True)`.
 */
export function scanHtml(html: string): { textChunks: string[]; anchors: Anchor[] } {
  const textChunks: string[] = [];
  const anchors: Anchor[] = [];
  const anchorStack: number[] = [];
  const skipStack: string[] = [];
  let textBuf = "";
  let i = 0;

  const flush = () => {
    if (!textBuf) return;
    const t = textBuf;
    textBuf = "";
    if (skipStack.length === 0) {
      textChunks.push(t);
      for (const idx of anchorStack) anchors[idx].text += t;
    }
  };

  while (i < html.length) {
    if (html[i] === "<") {
      const tag = parseTag(html, i);
      if (tag) {
        if (!tag.special) {
          flush();
          if (tag.closing) {
            if (skipStack.length && skipStack[skipStack.length - 1] === tag.name) skipStack.pop();
            // Inside a skip block (script/style/noscript/head/template), a tag-like
            // string is raw text — a JS template literal or JSON-LD payload, not a
            // real DOM node — so it must neither pop a real anchor nor be recorded.
            if (tag.name === "a" && anchorStack.length && skipStack.length === 0) anchorStack.pop();
          } else {
            if (SKIP_TEXT_TAGS.has(tag.name)) skipStack.push(tag.name);
            // Gate anchor recording the same way flush() gates text: only record
            // anchors parsed OUTSIDE script/style/noscript/head/template content.
            // (BeautifulSoup treats <script> content as raw text and would never
            // parse a tag-looking substring inside a JS string as a DOM anchor.)
            if (skipStack.length === 0 && tag.name === "a" && tag.attrs.href !== undefined) {
              anchors.push({ href: tag.attrs.href, text: "" });
              anchorStack.push(anchors.length - 1);
            }
          }
        }
        i = tag.endIndex;
      } else {
        textBuf += "<";
        i++;
      }
    } else {
      textBuf += html[i];
      i++;
    }
  }
  flush();

  // Mirror get_text(" ", strip=True): join with a space, then trim.
  for (const a of anchors) a.text = a.text.replace(/\s+/g, " ").trim();
  return { textChunks, anchors };
}
/**
 * All <a href> anchors on a page, mirrored from soup.find_all("a", href=True).
 */
export function extractAnchors(html: string): Anchor[] {
  return scanHtml(html).anchors;
}

/**
 * Page text, mirroring soup.get_text(" ", strip=True).
 * Each text chunk is stripped; chunks are joined with `separator`.
 */
export function htmlToText(html: string, separator = " "): string {
  const { textChunks } = scanHtml(html);
  return textChunks
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(separator);
}

/**
 * Find same-domain contact/about-style links on a page. Ported directly from
 * automation.py's _find_contact_links (the standalone desktop extractor's proven
 * "Deep search" behavior): checks BOTH the href and the link's visible text
 * against the keyword list, and only follows links on the SAME domain as baseUrl.
 */
export function findContactLinks(html: string, baseUrl: string, limit = MAX_CONTACT_LINKS_PER_PAGE): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const baseNetloc = netlocOf(baseUrl);
  for (const a of extractAnchors(html)) {
    const combined = `${a.href} ${a.text}`.toLowerCase();
    if (!CONTACT_LINK_KEYWORDS.some((kw) => combined.includes(kw))) continue;
    const absUrl = absoluteUrl(a.href, baseUrl);
    if (netlocOf(absUrl) !== baseNetloc) continue;
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);
    found.push(absUrl);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * Scan a page for <a href> links pointing at a PDF (case-insensitive, ignoring a
 * trailing query string), resolve each to an absolute URL, dedupe, and cap at
 * `limit`. Ported from _find_embedded_pdf_links.
 */
export function findEmbeddedPdfLinks(html: string, baseUrl: string, limit = MAX_EMBEDDED_PDFS_PER_PAGE): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const a of extractAnchors(html)) {
    if (!a.href) continue;
    const path = a.href.toLowerCase().split("?")[0].replace(/\/+$/, "");
    if (!path.endsWith(".pdf")) continue;
    const absUrl = absoluteUrl(a.href, baseUrl);
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);
    found.push(absUrl);
    if (found.length >= limit) break;
  }
  return found;
}

/** The browser User-Agent the engine sends on page/PDF fetches. Mirrors BROWSER_USER_AGENT. */
export const CRAWL_USER_AGENT = BROWSER_USER_AGENT;