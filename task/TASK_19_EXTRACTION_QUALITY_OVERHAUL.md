# Task 19 — Extraction quality overhaul (all pieces, hand off one at a time)

**Status: ready to implement, split into independent pieces.** Written 2026-09-11. Each piece below is self-contained — give Cline one section at a time, in the order listed (later pieces build on earlier ones, but each is independently testable and shippable on its own). This document **supersedes and folds in** `TASK_18_CONTACT_PAGE_FOLLOWING_AND_PROGRESS.md` — Piece 1 below is that task's content, unchanged; that file can be deleted once Piece 1 ships.

## Context — what's confirmed, not guessed

- Directly inspected the standalone Windows desktop app's own working code (`lead-extractor-windows-build.zip`, the most recent build) to find why manual/standalone results are better: it follows same-domain contact/about pages (`app/search/deep_scraper.py`), which the web worker never does today.
- Directly tested a real failing example (a Scribd-hosted PDF) with a real headless Chromium browser, not just plain HTTP: Scribd serves a CAPTCHA challenge to automated browsers regardless of rendering method. This is a deliberate anti-bot measure, not a rendering gap — no amount of JS-rendering support gets past it. Confirmed live: `Contains @bellsouth.net: False`, page text was literally `"Enter the characters seen in the image below: Download audio CAPTCHA Answer Submit"`.
- Per explicit direction: don't build a CAPTCHA solver. If an easy, one-click "I'm not a robot" style checkbox is present, attempting that click is fine (it's just a click, not solving anything) — but if a real challenge (image/audio/puzzle) is served, skip that one result cleanly and move on. Never block the job waiting on a challenge.
- Every result must be accounted for — found, extracted, skipped (why), or failed (why) — so nothing silently vanishes from a run without a trace.

---

## Piece 1 — Follow contact/about pages (same-domain, proven reference)

*(This is `TASK_18_CONTACT_PAGE_FOLLOWING_AND_PROGRESS.md`'s content in full — implement this first, delete that file once it ships.)*

### What this closes

The standalone desktop extractor has a "Deep search" checkbox (`app/desktop.py`) that, when enabled, routes every result through `deep_scrape_pages`/`deep_scrape_single` (`app/search/deep_scraper.py`) instead of a plain single-page fetch. That function does three things per result: (1) fetch the main page, (2) find and visit up to 5 contact/about-style sub-pages on the same domain, (3) find and parse up to 3 embedded PDF links — then combines all of it into one text blob before extraction. A separate task already ported piece (3) into `worker/automation.py` (`_find_embedded_pdf_links`/`_fetch_pdf_text`, already shipped). This piece ports (2), the actual missing piece: a lot of real business sites don't have contact info on the page that shows up in search results (often the homepage) — it's on a separate `/contact` or `/about` page, which today's `extract_lead_page` never visits. Very likely the single biggest reason manual/standalone searches outperform the automated job.

### The proven reference implementation

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

Two details matter and must carry over exactly: (a) it checks both the link's `href` AND its visible link text against the keyword list, and (b) it only follows links on the **same domain** — never leaves the business's own site.

### Implementation, in `worker/automation.py`

**Confirmed**: `urlparse` is NOT currently imported (the existing import line is `from urllib.parse import parse_qs, quote_plus, unquote, urljoin`). Add it to that same line.

New constants and helper, near `_MAX_EMBEDDED_PDFS_PER_PAGE`:

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

Wire into `extract_lead_page`, which needs a new optional `on_step: Optional[SyncStepCallable] = None` parameter (thread it from `_extract_result`'s existing call site):

```python
def extract_lead_page(result: SearchResult, on_step: Optional[SyncStepCallable] = None) -> list[dict]:
    ...
    soup = BeautifulSoup(html, "lxml")

    combined_text_parts = [soup.get_text(" ", strip=True)]

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

### Also in this piece: raise the failure-pause threshold

`CONSECUTIVE_FAILURE_PAUSE_THRESHOLD` in `run_automation` is currently `3` — given this file's own extensive comments about how often DDG/Google anti-bot blocking happens, that's a fairly low bar to declare "the search engine looks down" and pause the whole job short of its target. Raise it to `5`. One-line constant change; don't restructure the surrounding pause/resume logic, which is otherwise correct.

### Explicitly out of scope for this piece

- Scribd and CAPTCHA-walled sites — covered by Pieces 2/3 below, not here.
- Switching PDF libraries (`pypdf` vs `pdfplumber`) — no evidence yet this matters.

### Verification

1. `python -m py_compile worker/automation.py`.
2. A page with a "Contact Us" link (by text, even if the href doesn't contain "contact") gets followed; an external link is correctly rejected even if its text says "Contact us on Facebook"; the cap of 5 is enforced.
3. Real end-to-end test: a business site known to have its email only on a separate `/contact` page — confirm a lead is now found where none was before.
4. `on_step` messages actually surface in the job's live activity feed during a real run.

---

## Piece 2 — Detect and skip CAPTCHA/bot-challenge pages (no solving, no browser needed)

### What this is for

Right now, if a result's page happens to be a CAPTCHA/bot-challenge page (like the confirmed Scribd example), `extract_lead_page` just extracts whatever sparse text is on that challenge page (often none) and moves on — which already doesn't break anything, but gives no visibility into *why* that result yielded nothing, and there's no shared, reusable way to recognize "this is a challenge page" for Piece 3 to build on.

### Implementation

New helper in `worker/automation.py`:

```python
_CAPTCHA_MARKERS = (
    "captcha",
    "verify you are human",
    "i'm not a robot",
    "unusual traffic",
    "enter the characters you see",
    "enter the characters seen in the image",
    "access denied",
    "checking your browser before accessing",
)

def _looks_like_challenge_page(text: str) -> bool:
    """Cheap heuristic: does this page's visible text look like a CAPTCHA/bot
    challenge rather than real content? Text-based, works against plain HTTP
    responses (no browser needed) -- confirmed against a real example (Scribd
    serves exactly 'Enter the characters seen in the image below... CAPTCHA').
    Deliberately conservative (checks a short, specific phrase list) to avoid
    false-positiving on a page that legitimately mentions "access" or "human"
    in unrelated contexts -- only trip on genuinely characteristic phrasing.
    """
    lowered = text.lower()
    return any(marker in lowered for marker in _CAPTCHA_MARKERS)
```

Wire into `extract_lead_page`, right after computing the page's own text (before following contact/PDF links — no point spending extra requests on a page that's already a dead end):

```python
    own_text = soup.get_text(" ", strip=True)
    if _looks_like_challenge_page(own_text):
        if on_step is not None:
            on_step(f"Skipped (bot challenge page): {result.url}")
        return []  # clean skip -- not an error, not a crash, just nothing here
    combined_text_parts = [own_text]
```

Also apply the same check inside the per-embedded-PDF and per-contact-page loops from Piece 1 (a linked sub-page or PDF-serving page can independently be challenge-walled even if the main result page wasn't) — skip that one sub-fetch's contribution to `combined_text_parts`, don't abort the whole result over it.

### Explicitly out of scope

- No OCR, no image analysis, no third-party CAPTCHA-solving service, no audio-challenge handling. If it's not a plain, recognizable text phrase, this piece does not attempt to identify or solve it — Piece 3's optional checkbox click is the only "interaction" ever attempted, and only for the specific one-click case described there.

### Verification

1. Feed `_looks_like_challenge_page` the real captured Scribd text (`"Enter the characters seen in the image below: Download audio CAPTCHA Answer Submit"`) — confirm it returns `True`.
2. Feed it a normal business page's text — confirm it returns `False` (no false positive).
3. Confirm a real challenge-walled result now produces a clear `"Skipped (bot challenge page): ..."` step message instead of silently yielding zero leads with no explanation.

---

## Piece 3 — Headless-browser fallback for JS-rendered pages (general capability, not a Scribd fix)

### What this is for, and what it is NOT for

Some real (non-CAPTCHA-walled) pages load their actual content via JavaScript after the initial page load — plain `requests.get()` gets back a near-empty shell, same *symptom* as the Scribd case but a completely different cause (missing JS execution, not bot-blocking). This piece adds a fallback: when a page's plain-HTTP fetch comes back suspiciously sparse, retry it with a real headless browser (Playwright, already a dependency here, already used for DDG pagination) before giving up on it.

**This will not rescue Scribd or similar CAPTCHA-walled sites** — Piece 2's challenge-page check still applies after the browser-rendered fetch, and a real challenge page still gets skipped, not solved. This piece is for the *other* category: real content that's simply JS-loaded, with no bot-wall in the way.

### The one narrow interaction this piece IS allowed to attempt

Per explicit direction: if, after rendering, the page shows a simple, single-click consent/dismissal element — the kind of "checkbox and continue" or "Accept and continue" pattern that isn't asking you to prove anything, just to acknowledge and proceed — attempt exactly one click on it, with a short timeout, then re-check the rendered content. If that doesn't resolve within a few seconds, or if what's actually shown is a real challenge (image puzzle, audio challenge, "type these characters"), stop and skip via Piece 2's existing check. Never retry the click, never wait indefinitely, never attempt to interpret an image or audio challenge.

### Implementation sketch

New function in `worker/automation.py` (or a new small module if that reads cleaner — match whichever existing convention `_launch_persistent_context`/`_resilient_page_content` already establish, since this reuses the same Playwright patterns):

```python
_SPARSE_TEXT_THRESHOLD = 200  # chars -- below this, a real page is suspicious enough to retry rendered

async def _render_page_text(url: str) -> str:
    """Fallback for a page whose plain-HTTP text came back suspiciously sparse:
    render it with a real (headless) browser and return the rendered visible
    text. Returns "" on any failure -- this is a best-effort fallback, never a
    hard requirement, and must never raise into the caller.

    Attempts exactly one click on an obvious single-step consent/dismissal
    control if present (a simple "Accept"/checkbox-style element -- NOT a
    challenge), with a short timeout, then re-reads the text. Does not attempt
    to identify or solve an actual CAPTCHA/puzzle challenge -- Piece 2's
    _looks_like_challenge_page() runs on whatever text this returns, same as
    any other fetch path.
    """
    from playwright.async_api import async_playwright
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                page = await browser.new_page(user_agent=BROWSER_USER_AGENT)
                await page.goto(url, wait_until="networkidle", timeout=20_000)
                # Best-effort, single attempt, short timeout -- a real consent
                # checkbox/button, not a challenge. Never raises past this try.
                try:
                    consent = page.locator(
                        "text=/^(accept|agree|continue|got it|i agree)$/i"
                    ).first
                    await consent.click(timeout=3_000)
                    await page.wait_for_timeout(1_000)
                except Exception:
                    pass  # no such element, or it didn't resolve -- fine, proceed with whatever's rendered
                return await page.inner_text("body")
            finally:
                await browser.close()
    except Exception:
        return ""
```

Wire into `extract_lead_page`, as a fallback specifically when the plain-HTTP text is sparse AND doesn't already look like a challenge page (no point rendering a page we're just going to skip anyway):

```python
    own_text = soup.get_text(" ", strip=True)
    if _looks_like_challenge_page(own_text):
        ...  # Piece 2, unchanged
    if len(own_text.strip()) < _SPARSE_TEXT_THRESHOLD:
        if on_step is not None:
            on_step(f"Page looks sparse, trying a rendered fetch: {result.url}")
        rendered_text = await _render_page_text(result.url)  # NOTE: extract_lead_page runs in a
                                                               # thread executor (sync context) --
                                                               # see the threading note below
        if rendered_text and _looks_like_challenge_page(rendered_text):
            if on_step is not None:
                on_step(f"Skipped (bot challenge page after render): {result.url}")
            return []
        if rendered_text.strip():
            own_text = rendered_text
    combined_text_parts = [own_text]
```

**Important threading note, read before implementing**: `extract_lead_page` is a *synchronous* function, called via `loop.run_in_executor(None, _extract_result, ...)` (confirmed in `_extract_result`'s own docstring: "runs in a run_in_executor thread and therefore can't await"). `_render_page_text` above is `async def`, using Playwright's *async* API — that doesn't directly work from inside a sync function running in a worker thread. The two real options: (a) use Playwright's *sync* API (`playwright.sync_api`) instead for this one helper, since it's being called from an already-synchronous, already-in-a-worker-thread context (simpler, no event-loop juggling — this matches how the standalone desktop app's own scraper code works, since it's a plain sync desktop app), or (b) restructure so this fallback happens in the async layer (`_extract_result`/`process_one`) instead of inside the sync `extract_lead_page`. **Prefer (a)** — it's the smaller, more contained change, and Playwright ships both APIs specifically for this kind of situation. Confirm this actually works (a sync Playwright call from inside a `run_in_executor` thread, which itself has no asyncio event loop) before considering this piece done — this is exactly the kind of thing that needs a real live test, not just a clean compile.

### Explicitly out of scope

- Not a general "re-render everything with a browser" change — only the sparse-text fallback path, gated by `_SPARSE_TEXT_THRESHOLD`, so the common case (a normal page with real HTML content) never pays the extra browser-launch cost.
- Not attempting more than one click, not waiting more than a few seconds, not attempting any challenge beyond a single-step consent dismissal.
- Not applied to the embedded-PDF or contact-page sub-fetches from Piece 1 in this pass — scope this to the main result page only; revisit if real usage shows those sub-fetches need it too.

### Verification

1. Confirm a sync-Playwright call from inside `run_in_executor`'s worker thread actually works in this codebase's real deployment environment (Linux VPS, not just local dev) — browser launch behavior can differ.
2. Real test: find (or construct) a genuinely JS-rendered, non-CAPTCHA-walled page with sparse initial HTML — confirm a lead is now extracted where the plain-HTTP path found nothing.
3. Re-run the confirmed Scribd example — confirm it's still correctly skipped (via Piece 2's check on the rendered text), not silently treated as a success with zero leads and no explanation.
4. Time the fallback path to understand its real per-page cost, and confirm `_SPARSE_TEXT_THRESHOLD` isn't triggering on normal, legitimately-short-but-real pages (a one-paragraph "under construction" business page shouldn't get mistaken for "needs JS" if 200 chars is too aggressive a cutoff — adjust if real testing shows this).

---

## Piece 4 — Explicit per-result accounting ("nothing goes missing")

### What this actually is, stated honestly

Reviewed `_search_and_extract`'s current code closely: every result already gets processed via `asyncio.gather(*[process_one(r) for r in unique_results], return_exceptions=True)` — a result that throws doesn't get lost or silently drop the batch, and every result's outcome (leads found, or an isolated exception) is already accounted for in `leads_per_result`. **There is no confirmed data-loss bug today** — results are processed concurrently (not one-at-a-time in visible sequence), which is what likely reads as "did everything actually get attempted?" from the outside, since the live activity feed shows one line at a time from whichever result happens to report a step next, not a clean 1-of-20, 2-of-20 sequence.

This piece is about making that existing correctness *visible and confirmable*, not fixing a hidden bug — say this plainly if asked, don't imply a bug was found where none was.

### Implementation

In `_search_and_extract`, after gathering `unique_results` and before dispatching `process_one` for each, report the batch size once:

```python
    if on_step is not None:
        await on_step(f"Extracting {len(unique_results)} result(s) from this search")
```

Give each result a stable sequence number and thread it through the step-reporting so activity messages read as a traceable sequence even though processing is concurrent (concurrency is a real speed win — don't remove it, just make its output legible):

```python
    async def process_one(result: SearchResult, seq: int, total: int) -> list[dict]:
        def report_step_sync(text: str) -> None:
            if on_step is not None:
                asyncio.run_coroutine_threadsafe(on_step(f"[{seq}/{total}] {text}"), loop)
        leads = await loop.run_in_executor(None, _extract_result, result, report_step_sync)
        ...
    leads_per_result = await asyncio.gather(
        *[process_one(r, i + 1, len(unique_results)) for i, r in enumerate(unique_results)],
        return_exceptions=True,
    )
```

Finally, after the batch completes, report one explicit summary line accounting for every result:

```python
    succeeded = sum(1 for item in leads_per_result if isinstance(item, list) and item)
    empty = sum(1 for item in leads_per_result if isinstance(item, list) and not item)
    errored = sum(1 for item in leads_per_result if isinstance(item, Exception))
    if on_step is not None:
        await on_step(
            f"Batch done: {len(unique_results)} result(s) -- {succeeded} yielded leads, "
            f"{empty} yielded none, {errored} errored"
        )
```

(`empty` includes both "genuinely no contact info found" and Piece 2's clean challenge-page skips — those aren't distinguished at this summary level; Piece 2's own per-result step message already explains *which* results were skipped and why, for anyone reading the full activity log rather than just the summary line.)

### Explicitly out of scope

- Not switching from concurrent to fully sequential processing — that would be a real, measurable speed regression for no correctness benefit, since concurrency isn't the source of any confirmed data loss.
- Not building a persisted, queryable "run report" artifact in this pass — plain `on_step` activity-log messages are enough for now; revisit only if real usage shows people need to review this after the fact rather than while a job is running.

### Verification

1. Run a real job with a mix of successful, empty, and (if reachable) challenge-walled results — confirm the final batch summary's numbers add up to exactly `len(unique_results)`.
2. Confirm the `[N/total]` prefix appears on every step message during a real run, and that all N values from 1 through total actually appear somewhere in the log (nothing skipped in the sequence numbering itself).

---

## Piece 5 — Frontend: auto-scroll the leads list to the latest entries

### What this is for

During a running job, new leads land at the bottom of `selectedJob.leads` (confirmed: the leads array is appended-to, not prepended) but the leads table (`app/dashboard/extract/page.tsx`, the `<tbody>` rendering `selectedJob.leads.map(...)`) has no auto-scroll behavior — a user watching a live run has to manually scroll down to see new leads as they arrive.

### Implementation

The leads table lives inside a scrollable container at line 738: `<div className="max-h-[70vh] flex-1 overflow-y-auto rounded-xl border border-border bg-card">`. Give it a ref, and scroll it to the bottom whenever `selectedJob.leads.length` changes **while the job is running** (don't auto-scroll a finished/historical job the user might be deliberately reading through from the top):

```tsx
const leadsScrollRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (selectedJob?.status === "running" && leadsScrollRef.current) {
    leadsScrollRef.current.scrollTop = leadsScrollRef.current.scrollHeight;
  }
}, [selectedJob?.leads.length, selectedJob?.status]);
```

Attach `ref={leadsScrollRef}` to that container div. Match this file's existing `useRef`/`useEffect` import and usage conventions (both are almost certainly already imported given the rest of this page's complexity — confirm before adding a duplicate import).

### Verification

1. Start a real job, watch the leads table while it's running — confirm it stays scrolled to the newest lead as more arrive, without fighting a user who's deliberately scrolled up to look at earlier entries (acceptable tradeoff: it will pull them back down on the next new lead, matching a standard "live tail" behavior — call this out if it feels wrong in practice, but implement the simple version first).
2. Open a finished/historical job — confirm it does NOT force-scroll on open; the user should land wherever the table naturally starts.

---

## Piece 6 — Frontend: hide search-query clutter from the leads listing during extraction

### What to confirm before touching anything

The exact "showing all the query" complaint needs to be pinned down against the real rendered UI before changing it — the current leads table (`selectedJob.leads.map`, same section as Piece 5) does NOT render a query/search-term column today (confirmed by reading the table's actual columns: Business, Name, Email, Phone, Website — no Query column exists). The clutter being described is more likely the **job list's own label** (`selectedJob`'s title, which the dispatcher builds by joining every query term with `" | "` — confirmed in `app/api/jobs/route.ts`'s `displayQuery` construction, and visible in the earlier screenshot as titles like "any@email.com + sbcglobal.net..." truncating a long joined-term string) showing up somewhere prominent **while a job is actively running**, not the leads table itself.

**Before implementing a fix, re-confirm with the user exactly where they see this** — screenshot or a specific element — since the two candidate locations (job list label vs. some other in-progress display) need different fixes, and guessing which one wastes a cycle the same way earlier guesses in this project did. Once confirmed, the fix is almost certainly: while `status === "running"`, show a shorter/generic label (e.g., "Extracting…" or the job's template name alone) in whatever specific spot was pointed out, and reserve the full joined-query display for once the job reaches a terminal state.

### Verification

1. Confirm the exact element/location with the user before writing code.
2. Once fixed, confirm the shortened running-state label still lets someone identify *which* job is which when multiple jobs run concurrently (don't over-shorten to the point two different jobs look identical while running).
