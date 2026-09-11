# Task 18 — Follow contact/about pages (proven, from the standalone extractor), and granular progress messages

**Status: SUPERSEDED — folded into `TASK_19_EXTRACTION_QUALITY_OVERHAUL.md` (Piece 1) unchanged.** Use that document instead; this file is kept only for history and can be deleted once Piece 1 ships. Written 2026-09-11, based on directly reading the standalone Windows desktop app's own working code (`lead-extractor-windows-build.zip`, `app/search/deep_scraper.py`), not guessed.

## What this closes

Confirmed directly: the standalone desktop extractor has a "Deep search" checkbox (`app/desktop.py`) that, when enabled, routes every result through `deep_scrape_pages`/`deep_scrape_single` (`app/search/deep_scraper.py`) instead of a plain single-page fetch. That function does three things per result: (1) fetch the main page, (2) **find and visit up to 5 contact/about-style sub-pages on the same domain**, (3) find and parse up to 3 embedded PDF links — then combines all of it into one text blob before extraction. Task 17 already ported piece (3). This task ports piece (2), the actual missing piece: **a lot of real business sites don't have contact info on the page that shows up in search results (often the homepage) — it's on a separate `/contact` or `/about` page**, which today's `extract_lead_page` never visits at all. This is very likely the single biggest reason manual searches (where a person naturally clicks through to a Contact page) outperform the automated job.

## The proven reference implementation (read this before writing anything)

From `deep_scraper.py`, confirmed working in the shipped desktop app:

```python
CONTACT_KEYWORDS = [
    "contact", "about", "team", "staff", "people", "leadership",
    "our-team", "about-us", "contact-us", "get-in-touch", "meet",
    "directory", "management", "who-we-are",
]

def _is_contact_link(href: str, text: str) -> bool:
    combined = f"{href} {text}".lower()
    return any(kw in combined for kw in CONTACT_KEYWORDS)

def _find_contact_links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    links = set()
    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"]
        text = a_tag.get_text(strip=True)
        if _is_contact_link(href, text):
            full_url = urljoin(base_url, href)
            if urlparse(full_url).netloc == urlparse(base_url).netloc:
                links.add(full_url)
    return list(links)[:5]
```

Two details matter and must carry over exactly: (a) it checks both the link's `href` AND its visible link text against the keyword list (a link literally reading "Contact Us" with an href of `/p/42` would be missed by checking the URL alone), and (b) it only follows links on the **same domain** (`netloc` match) — never leaves the business's own site.

## Implementation, matching Task 17's established shape in `worker/automation.py`

### 1. New constants and helper, near `_MAX_EMBEDDED_PDFS_PER_PAGE`

```python
_MAX_CONTACT_LINKS_PER_PAGE = 5
_CONTACT_LINK_KEYWORDS = [
    "contact", "about", "team", "staff", "people", "leadership",
    "our-team", "about-us", "contact-us", "get-in-touch", "meet",
    "directory", "management", "who-we-are",
]

def _find_contact_links(soup: "BeautifulSoup", base_url: str, limit: int = _MAX_CONTACT_LINKS_PER_PAGE) -> list[str]:
    """Find same-domain contact/about-style links on a page -- ported directly
    from the standalone desktop extractor's deep_scraper.py (_find_contact_links),
    confirmed as its real, working "Deep search" behavior. Checks BOTH the href
    and the link's visible text against the keyword list, and only follows links
    on the SAME domain as base_url -- never leaves the business's own site.
    """
    found: list[str] = []
    seen: set[str] = set()
    base_netloc = urlparse(base_url).netloc
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(strip=True)
        combined = f"{href} {text}".lower()
        if not any(kw in combined for kw in _CONTACT_LINK_KEYWORDS):
            continue
        abs_url = _absolute_url(href, base_url)
        if urlparse(abs_url).netloc != base_netloc:
            continue
        if abs_url in seen:
            continue
        seen.add(abs_url)
        found.append(abs_url)
        if len(found) >= limit:
            break
    return found
```

**Confirmed**: `urlparse` is NOT currently imported (the file's existing import line is `from urllib.parse import parse_qs, quote_plus, unquote, urljoin` — no `urlparse`). Add it to that same line.

### 2. Wire into `extract_lead_page`, alongside Task 17's PDF-following, with progress reporting

`extract_lead_page` needs a new optional `on_step: Optional[SyncStepCallable] = None` parameter (it doesn't accept one today — `_extract_result` will need to pass its own `on_step` through to it, a one-line change there).

```python
def extract_lead_page(result: SearchResult, on_step: Optional[SyncStepCallable] = None) -> list[dict]:
    ...
    soup = BeautifulSoup(html, "lxml")

    combined_text_parts = [soup.get_text(" ", strip=True)]

    # Task 18: follow same-domain contact/about pages -- the standalone
    # extractor's proven "Deep search" behavior. Many real sites don't have
    # contact info on the page that shows up in search results.
    contact_links = _find_contact_links(soup, result.url)
    if on_step is not None and contact_links:
        on_step(f"Found {len(contact_links)} contact page(s) on {result.url}")
    for link in contact_links:
        if on_step is not None:
            on_step(f"Visiting contact page: {link}")
        try:
            sub_resp = requests.get(link, headers={"User-Agent": BROWSER_USER_AGENT}, timeout=REQUEST_TIMEOUT_SECONDS)
            sub_resp.raise_for_status()
            sub_text = BeautifulSoup(sub_resp.text, "lxml").get_text(" ", strip=True)
            combined_text_parts.append(sub_text)
        except Exception:
            continue  # one bad sub-page doesn't stop the rest

    # Task 17: embedded PDF links (unchanged from the existing implementation)
    for pdf_url in _find_embedded_pdf_links(soup, result.url):
        if on_step is not None:
            on_step(f"Opening PDF: {pdf_url}")
        pdf_text = _fetch_pdf_text(pdf_url)
        if pdf_text.strip():
            if on_step is not None:
                on_step(f"Extracted {len(pdf_text)} characters from PDF")
            combined_text_parts.append(pdf_text)

    page_text = "\n".join(combined_text_parts)
    ...
```

Thread `on_step` through the one call site in `_extract_result` (`return extract_lead_page(result, on_step)`), matching exactly how `extract_lead_pdf`'s own call is already parameterless-but-could-take-one — check whether `extract_lead_pdf` should ALSO get a matching "Reading a PDF" style message for consistency (it already gets one from `_extract_result` itself, one level up, so no change needed there).

### 3. Reconsider `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD`

Currently `3` (in `run_automation`, near the main query loop). Given this file's own extensive comments about how often DuckDuckGo/Google anti-bot blocking happens, 3 consecutive query failures is a fairly low bar to declare "the search engine looks down" and pause the whole job — this is a plausible contributor to jobs stopping well short of their max-duration or target-lead-count. Raise it to `5`. This is a small, low-risk, one-line constant change — don't restructure the surrounding pause/resume logic, which is otherwise correct and already well-reasoned (resumable via `resume_state`, doesn't retry the isolated failures that stayed under threshold).

## Explicitly out of scope

- **Scribd and similar JS-rendered document sites** — confirmed separately (fetched a real example directly: the raw HTML response is ~3KB and contains none of the actual document's content, which loads entirely client-side via JavaScript). No HTTP-based fix (this task included) can reach that content; it would need a real headless-browser render (Playwright, already used elsewhere in this file for DDG pagination) per such result, which is a materially bigger, separate piece of work. Do not attempt it in this task.
- Not switching the PDF library from `pypdf` to `pdfplumber` (the standalone extractor uses `pdfplumber`) — no evidence yet that this matters for extraction quality; revisit only if a real PDF is found where `pypdf` fails but `pdfplumber` succeeds.
- Not touching the non-deep-search fallback path conceptually — this file has no such toggle to begin with; contact-page-following becomes the standard behavior for every HTML result, not an opt-in.
- Not changing `_MAX_EMBEDDED_PDFS_PER_PAGE` (stays 3, matching the standalone's own PDF cap) — only the contact-link cap (5) and the failure-pause threshold are being adjusted in this pass.

## Verification

1. `python -m py_compile worker/automation.py`.
2. Unit-style check (like Task 17's own verification): a page with a "Contact Us" link (by text, even if the href itself doesn't contain "contact") gets followed; a same-domain-only check correctly rejects an external link even if its text says "Contact us on Facebook"; the cap of 5 is enforced.
3. Real end-to-end test: pick a business site known to have its email on a separate `/contact` page and nothing extractable on its homepage — confirm a lead is now found where none was before.
4. Confirm `on_step` messages actually surface in the job's live activity feed during a real run (this is directly testable in the dashboard's "Currently: …" line).
5. Confirm the `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD` change alone doesn't mask a genuine sustained outage — a job hitting 5 real consecutive failures should still pause, just with slightly more tolerance for a short blip than 3 gave it.
