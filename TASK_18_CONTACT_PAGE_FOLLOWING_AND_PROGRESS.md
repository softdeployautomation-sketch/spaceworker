# Task 18 — Follow contact/about pages (proven, from the standalone extractor), and granular progress messages

**Status: SPLIT INTO 2 PARTS. PART 1 is DONE (merged into `worker/automation.py`, verified). PART 2 below is the NEXT AGENT'S SCOPE — start there.** Written 2026-09-11 from directly reading the standalone Windows desktop app's own working code (`lead-extractor-windows-build.zip`, `app/search/deep_scraper.py`), not guessed.

## Split & status

| Part | Scope | Status |
| --- | --- | --- |
| **1** | §4 — Bounded reCAPTCHA v2 checkbox solver (try to solve before backing off; skip-to-next on failure). | **DONE** — in `worker/automation.py`, verified. Nothing in PART 1 overlaps PART 2. |
| **2** | §1–§3 — Follow same-domain contact/about pages + granular `on_step` progress in `extract_lead_page` + `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD` 3 to 5. | **DONE** — implemented in `worker/automation.py` and verified locally: `py_compile` clean; `_find_contact_links` unit check (text-match, same-domain-only, cap 5) passed; end-to-end check (email found only on a `/contact` sub-page; dead sub-page skipped; `on_step` messages emitted) passed; PDF extraction confirmed uncapped (30 distinct emails in one PDF → 30 leads). Only live-site/dashboard confirmation remains (see Verification → PART 2). |

## PART 1 — COMPLETE (already merged; do NOT redo)

Landed in `worker/automation.py` and verified locally (`python -m py_compile worker/automation.py` + a fake-page unit check):
- Constants near `CAPTCHA_BACKOFF_SECONDS` (~L239): `CAPTCHA_CHECKBOX_SELECTOR`, `CAPTCHA_SOLVE_SETTLE_SECONDS`, `CAPTCHA_SOLVE_ATTEMPTS`.
- `_try_solve_recaptcha(page) -> bool`, defined just before `_resilient_page_content` — bounded checkbox solve, returns `True` only when cleared.
- Wired into `_one_attempt` inside `_resilient_page_content`: tries to clear the challenge first and re-reads `page.content()` on success; only then raises `_BlockedByCaptchaError`, so the existing skip-to-next fallback is untouched.

The §4 text lower in this file is kept for history/reference only.

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

## PART 2 — NEXT AGENT: implement §1–§3 below

Four steps, in order, all in `worker/automation.py`. Confirmed current state (2026-09-11): `extract_lead_page(result)` (L849) takes NO `on_step`; `_extract_result` (L1031) calls `return extract_lead_page(result)` (L1049) without passing its own `on_step`; the import at L43 (`from urllib.parse import parse_qs, quote_plus, unquote, urljoin`) has NO `urlparse`; `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 3` (L1323); `SyncStepCallable` (L111) and `_absolute_url` (L165) already exist; `_find_embedded_pdf_links` (L981, Task 17) is the helper to mirror in style.

`on_step` here is a SYNC reporter (`SyncStepCallable = Callable[[str], None]`, Task 14) — keep this layer sync; the async threading onto the event loop lives one level up in `run_automation` and is already handled. Don't touch PART 1's `_try_solve_recaptcha` / `_resilient_page_content`.

**Done when** the Verification section's PART 2 items pass (see below).

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

### 4. Try to solve CAPTCHAs — bounded attempt, with a skip-to-next fallback  *(PART 1 — DONE, kept for reference)*

This closes the last real gap in the anti-bot story, and is the one that most directly decides whether we beat the leads-extraction market on blocked-IP days. Confirmed in `worker/automation.py`: the browser path already **detects** a CAPTCHA and backs off, but it **never tries to solve one**. `_resilient_page_content` builds a live `page`, reads `page.content()`, and the moment a `captcha_markers` substring matches it raises `_BlockedByCaptchaError` — then just sleeps `CAPTCHA_BACKOFF_SECONDS` (20s) and retries. The single most common obstacle — a **reCAPTCHA v2 checkbox**, which a real user would click and clear in about a second — is never clicked; the job only waits and re-fetches. That costs real leads any time a challenge would have self-cleared on one click.

So this piece gives the automation a genuine, *bounded* "try to solve" step first, and makes the unsolvable path explicitly skip to the next query rather than stall.

#### 4a. What it takes to solve the common case (reCAPTCHA v2 checkbox)

- reCAPTCHA v2's checkbox is a real clickable control (`.recaptcha-checkbox-border`, inside the `.g-recaptcha` wrapper). Clicking it and letting the verifying-spinner settle either clears the challenge (checkbox ticks, no new frame) or — from a lower-reputation IP — spawns an image-grid challenge.
- The tractable automated solve is: click once → wait a short settle period → re-check. If the checkbox is gone **and** no image-grid appeared, we're unblocked: re-read `page.content()` and continue. If an image-grid / multi-select / freeform challenge appeared instead, that is **not** reliably automatable (image classification + OCR of the grid is fragile, IP/rotation-dependent, and expensive) — that branch deliberately falls through to "unsolved" → the skip fallback. Do **not** build an image-grid solver in this pass.

#### 4b. The plumbing that makes it possible (the current code only ever sees a string)

`_resilient_page_content` returns a `str` and discards the live `page` object, so today there is no place to click. The solver must run **inside** `_one_attempt`, on the live async `page`, *before* the blocked decision — then it can still fall through to the raise exactly as today.

```python
# Near CAPTCHA_BACKOFF_SECONDS (~automation.py L239).
CAPTCHA_CHECKBOX_SELECTOR = ".recaptcha-checkbox-border"
CAPTCHA_SOLVE_SETTLE_SECONDS = 4.0   # allow the verify spinners to settle
CAPTCHA_SOLVE_ATTEMPTS = 2           # one real click + one re-check after a wait

async def _try_solve_recaptcha(page) -> bool:
    """Best-effort, bounded reCAPTCHA v2 checkbox solve on a live async Page
    (Playwright async_api, matching _resilient_page_content).

    Returns True only when the checkbox challenge has actually cleared. Raises
    nothing; a page that stays challenged, or that throws off an image-grid /
    freeform challenge, simply returns False so the caller falls through to the
    existing 'blocked' -> skip fallback. Deliberately does NOT attempt image-grid
    / multi-select classification (fragile, IP-dependent, expensive).
    """
    try:
        checkbox = page.locator(CAPTCHA_CHECKBOX_SELECTOR).first
        if not await checkbox.count():
            return False                       # not a checkbox challenge — not solvable here
        await checkbox.click()
        await page.wait_for_timeout(int(CAPTCHA_SOLVE_SETTLE_SECONDS * 1000))
        still = await page.locator(CAPTCHA_CHECKBOX_SELECTOR).count()
        grid = await page.locator(".rc-anchor-container, .fbc-imageselect").count()
        return (not still) and (not grid)      # checkbox gone AND no grid = cleared
    except Exception:
        return False
```

Wire it into `_one_attempt`: try the solve FIRST, and only raise `_BlockedByCaptchaError` if it fails:

```python
        for marker in captcha_markers:
            if marker.lower() in lowered:
                if await _try_solve_recaptcha(page):   # NEW (Task 18 #4) — try to clear it
                    content = await page.content()     # re-read after a successful solve
                    break
                raise _BlockedByCaptchaError(f"blocked: '{marker}' marker present")
        return content
```

Effort bound: keep the whole solve inside the existing `NAV_MAX_ATTEMPTS` / backoff budget — solving is constant-time per attempt (`CAPTCHA_SOLVE_ATTEMPTS`, settle seconds), introduces no new unbounded loop, so one stubborn page can't hang a job. After a failed solve, the existing flow still applies `CAPTCHA_BACKOFF_SECONDS` before the next attempt and recreates the context — reused unchanged.

#### 4c. The fallback when it doesn't solve — skip to the next one in line

- **Search-engine level** (`search_phase`, automation.py ~L671): the fallback chain already exists and is kept as-is — Google → exit nodes → DDG, and DDG → Playwright → exit nodes. The solver just inserts a genuine "try once" *before* those give up; an unsolvable captcha still yields no results / hits the existing handler, never a hard job-abort.
- **Query level** (`run_automation`, automation.py ~L1289): a query whose captcha we couldn't solve surfaces as a failed `_search_and_extract` → the existing `except Exception: consecutive_failures += 1; ... continue` **skips it and moves to the NEXT term in `ordered_queries`**. That is exactly the "skip to the next one in line" behavior. The section-3 change (threshold 3 → 5) is what keeps a short run of unsolvable captchas from pausing the whole job — a real solve plus the raised threshold together mean one IP / one query getting captcha'd no longer costs every remaining result.
- Do **not** add a new abort path: an unsolvable captcha must count as a normal "no leads" fall-through (engine-level) or an isolated skipped query (loop-level), never an exception that halts the job.

## Explicitly out of scope

- **Scribd and similar JS-rendered document sites** — confirmed separately (fetched a real example directly: the raw HTML response is ~3KB and contains none of the actual document's content, which loads entirely client-side via JavaScript). No HTTP-based fix (this task included) can reach that content; it would need a real headless-browser render (Playwright, already used elsewhere in this file for DDG pagination) per such result, which is a materially bigger, separate piece of work. Do not attempt it in this task.
- Not switching the PDF library from `pypdf` to `pdfplumber` (the standalone extractor uses `pdfplumber`) — no evidence yet that this matters for extraction quality; revisit only if a real PDF is found where `pypdf` fails but `pdfplumber` succeeds.
- Not touching the non-deep-search fallback path conceptually — this file has no such toggle to begin with; contact-page-following becomes the standard behavior for every HTML result, not an opt-in.
- Not changing `_MAX_EMBEDDED_PDFS_PER_PAGE` (stays 3, matching the standalone's own PDF cap) — only the contact-link cap (5) and the failure-pause threshold are being adjusted in this pass.
- **Not building an image-grid / multi-select / audio reCAPTCHA solver** — the checkbox solve (4a) is the tractable, high-value target; grid/multi-select classification and speech-to-text for audio challenges are fragile, IP/rotation-dependent, and expensive, and are explicitly left to the "skip to next" fallback (4c) rather than attempted here.
- **Not making the CAPTCHA solver configurable via job params** — `CAPTCHA_SOLVE_*` stay fixed constants this pass (same reasoning as `_MAX_EMBEDDED_PDFS_PER_PAGE` and `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD`).

## Verification

### PART 1 — DONE (logged here for completeness; do not re-run as a blocker)

6. Unit-style: with a fake page fixture exposing a `.recaptcha-checkbox-border` locator, assert `_try_solve_recaptcha` returns `True` when the checkbox disappears after the click and no grid shows, and `False` when a grid appears or no checkbox exists. Assert `_one_attempt` re-reads `page.content()` after a successful solve instead of raising `_BlockedByCaptchaError`. — **PASSED locally** (fake-page fixture: cleared→True, grid→False, no-checkbox→False).
7. Integration: point a job at a query/engine that historically serves the anomaly/captcha page and confirm (a) the checkbox is actually clicked and, when solvable, results now arrive without falling to an engine/exit-node fallback; (b) when an image-grid appears, the query is skipped (`consecutive_failures` incremented) and the job moves to the next term rather than stalling or aborting.
8. Confirm the `CAPTCHA_SOLVE_*` constants bound total solve time — a stuck/broken checkbox page can't exceed the existing `NAV_MAX_ATTEMPTS` / backoff budget for that query.

### PART 2 — NEXT AGENT'S PASS CRITERIA (all must hold before this part is done)

1. `python -m py_compile worker/automation.py`.
2. Unit-style check (like Task 17's own verification): a page with a "Contact Us" link (by text, even if the href itself doesn't contain "contact") gets followed; a same-domain-only check correctly rejects an external link even if its text says "Contact us on Facebook"; the cap of 5 is enforced.
3. Real end-to-end test: pick a business site known to have its email on a separate `/contact` page and nothing extractable on its homepage — confirm a lead is now found where none was before.
4. Confirm `on_step` messages actually surface in the job's live activity feed during a real run (this is directly testable in the dashboard's "Currently: …" line).
5. Confirm the `CONSECUTIVE_FAILURE_PAUSE_THRESHOLD` change alone doesn't mask a genuine sustained outage — a job hitting 5 real consecutive failures should still pause, just with slightly more tolerance for a short blip than 3 gave it.
