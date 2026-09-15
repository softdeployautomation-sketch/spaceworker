/**
 * DuckDuckGo plain-HTTP search — a faithful TypeScript port of the worker's
 * `duckduckgo_search_http()` + `_parse_ddg_html()` + `_decode_ddg_url()` (see
 * worker/automation.py), reduced to just enough for THIS slice's end-to-end path.
 *
 * Per the Task 27 plan, local-engine deliberately excludes the search-I/O layer
 * ("search crawling ... is out of scope"), so this lives with the extract route
 * rather than inside local-engine. It reuses two URL helpers that local-engine
 * already ports (`absoluteUrl`, `decodeDdgUrl`) instead of re-implementing them.
 *
 * Important fidelity note carried over verbatim from the worker docstring: the
 * plain-HTTP DDG endpoint is UNRELIABLE — roughly half the time (request/IP/
 * query dependent) it serves its real "anomaly" anti-bot CAPTCHA page (HTTP 202
 * with an `anomaly-modal` div, or a stripped error page) instead of `.result`
 * markup. This simple port treats a detected block as "zero results for that
 * query" (surfaced as a step message) and moves on — a pragmatic choice for the
 * demo. A production-grade multi-engine resilient search layer is explicitly
 * NOT this slice (it's the future work this simple path replaces).
 */
import { absoluteUrl, decodeDdgUrl, CRAWL_USER_AGENT } from "@/local-engine/src/html";
import type { SearchResult } from "@/local-engine/src/lead";

const DDG_URL = "https://html.duckduckgo.com/html/";

// The same TWO block-page markers the worker checks (see _DDG_BLOCK_MARKERS):
// DDG's actual CAPTCHA challenge div, and the separate stripped error page it
// serves specifically to automated/headless browsers.
const DDG_BLOCK_MARKERS = ["anomaly-modal", "if this persists, please email us"];

/** True when DDG served an anti-bot challenge instead of `.result` markup. */
function isDdgBlockPage(content: string): boolean {
  const lowered = content.toLowerCase();
  return DDG_BLOCK_MARKERS.some((m) => lowered.includes(m));
}

/** Strip HTML tags and collapse whitespace — a tiny stand-in for get_text(" ", strip=True). */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One decoded DDG result. */
export interface DdgOutcome {
  results: SearchResult[];
  /** True when DDG answered with a challenge/block page rather than results. */
  blocked: boolean;
}

/**
 * Plain-HTTP DuckDuckGo search for `query`, up to `maxResults` results.
 * Never throws for a DDG block or an HTTP error — returns `{ blocked: true }` /
 * empty results so the orchestration can surface it as a step and continue.
 */
export async function duckDuckGoSearch(query: string, maxResults: number): Promise<DdgOutcome> {
  const url = `${DDG_URL}?q=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": CRAWL_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { results: [], blocked: false };
  }

  // 403/429 from DDG's plain-HTTP endpoint is a block/rate-limit response (the
  // worker's docstring confirms a real 403 was hit in live testing).
  if (res.status === 403 || res.status === 429) return { results: [], blocked: true };
  if (!res.ok) return { results: [], blocked: false };

  const html = await res.text();
  if (isDdgBlockPage(html)) return { results: [], blocked: true };

  // Result titles/hrefs appear in `.result__a` anchors; snippets in `.result__snippet`.
  // They occur in the same per-result order, so we zip them — the lightest faithful
  // analogue of BeautifulSoup's `.result` block iteration for a single page.
  const titleAnchors: { title: string; href: string }[] = [];
  const aRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    const rawHref = (m[1] ?? "").trim();
    if (!rawHref) continue;
    titleAnchors.push({
      // _absolute_url then _decode_ddg_url — same ordering as _parse_ddg_html.
      href: decodeDdgUrl(absoluteUrl(rawHref, DDG_URL)),
      title: stripTags(m[2] ?? ""),
    });
  }

  const snippets: string[] = [];
  const sRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  while ((m = sRe.exec(html))) {
    snippets.push(stripTags(m[1] ?? m[2] ?? ""));
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < titleAnchors.length && results.length < maxResults; i++) {
    const { title, href } = titleAnchors[i];
    results.push({ title, url: href, snippet: snippets[i] ?? "" });
  }
  return { results, blocked: false };
}