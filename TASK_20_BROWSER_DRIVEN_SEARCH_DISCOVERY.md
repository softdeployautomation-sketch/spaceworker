# Task 20 — Browser-driven, click-through search discovery (alternative to raw HTML parsing)

**Status: ready to consider, real tradeoffs below — read before assigning.** Written 2026-09-11, based on directly reading the standalone extractor's FastAPI/WebSocket server (`lead-extractor-windows-build.zip`, `app/server/automation_server.py`, its `AutomationManager` class).

## What this actually is (correcting an earlier assumption in this project)

This is **not** an extraction-quality fix — Task 19 (contact/about-page following, PDF-following, CAPTCHA-skip) already covers that ground. This is about **how search results get discovered in the first place**. Confirmed by reading the code directly: `automation_server.py` drives a real Playwright browser that clicks an actual result link on the search engine's own results page (`title_elem.click()`, with fallbacks to clicking the link element, then a raw JS click), waits for real navigation, and — only after that — extracts the destination page's content via a **plain `httpx` HTTP fetch**, not by reading anything from the browser's rendered page. It then calls `page.go_back()` to return to the search results and repeats for the next result. So the browser isn't a better extractor; it's a better way to walk the result list without ever parsing the search engine's raw HTML/DOM structure directly (which `worker/automation.py`'s `_parse_ddg_html`/Google-parsing functions do today).

**Why this might matter**: parsing a search engine's raw HTML is exactly the kind of pattern anti-bot systems are tuned to detect (no real mouse/click events, no realistic timing, direct DOM scraping). Clicking through the actual rendered UI like a person would is a plausible reason this approach experiences fewer blocks — this is a reasonable hypothesis based on how these systems generally work, but has not been proven with a real side-by-side comparison against `worker/automation.py`'s current approach. Confirm this really helps before treating it as settled.

## The real cost — read this before assigning

- **One persistent browser per running job**, open for the job's entire duration (not launched-and-closed per request the way `duckduckgo_search_paginated` already does for a single search page). On a shared VPS running multiple concurrent jobs across lanes, this is meaningfully more memory/CPU per job than the current lightweight HTTP-based approach.
- **Sequential, one result at a time** (click → wait → extract → go back → click next) — the current `_search_and_extract` processes every result on a page concurrently via `asyncio.gather`. This will be slower per job, likely substantially so for a job with many results.
- **More fragile in a different way**: real click-and-navigate has its own failure modes (this reference implementation has three levels of click fallback — title click, link click, raw JS click — plus explicit navigation-verification via URL comparison, plus separate go-back-failure recovery via re-navigating to a fresh search). Porting this properly means porting that whole resilience ladder, not just the happy path.

## Recommendation before committing Cline time to a full port

Given the cost, validate the hypothesis cheaply first rather than porting the whole thing blind:

1. Take one real query that's been getting poor results in `worker/automation.py` today.
2. Manually or with a small throwaway script, compare: how many of that query's DDG/Google results does the *current* raw-HTML-parsing search step actually return, versus how many a real click-through pass turns up for the same query at the same time. If the raw-HTML approach is already finding the same result set the click-through approach would, the browser-driven discovery isn't the bottleneck and this task isn't worth its cost — the gap is elsewhere (which Task 19 already targets).
3. Only proceed with the full port below if that comparison shows raw-HTML parsing is genuinely missing results a real click-through pass would find.

## If validated: scope of the actual port

This is deliberately not written as ready-to-implement code the way Task 19's pieces are — it needs the validation step above first, and the real reference implementation (`automation_server.py`'s `run_automation` method, ~430 lines from line 557, plus `extract_from_pdf`/`extract_from_html`) is large enough that a faithful port is its own multi-piece effort. If Piece 1's validation confirms this is worth doing, come back and this section will be broken into concrete, Cline-sized pieces the same way Task 19 was — not attempted as one big change.

Rough shape it would take, for planning purposes only:
- A new, isolated search-discovery function (separate from `search_phase`/`duckduckgo_search_paginated`) that opens one browser context for the whole job, clicks through Google/DDG's own results and pagination the way `automation_server.py` does, and yields `SearchResult`s one at a time rather than returning a full list upfront.
- A concurrency cap on how many jobs may use this browser-driven path simultaneously (a new semaphore, separate from the existing lane concept), sized conservatively given the VPS's real available memory — this must not be allowed to run unbounded alongside the existing lightweight jobs.
- A fallback to the current raw-HTML approach if browser-driven discovery itself fails (browser crash, launch failure) — never let this become a single point of failure for a job that would otherwise have worked fine the old way.

## Explicitly out of scope for now

- Not implementing this yet — the validation step above comes first.
- Not touching `extract_from_pdf`/`extract_from_html`'s actual content-fetching approach even if this is ported — confirmed they already use plain HTTP (`httpx`), matching what Task 19 already builds on; only the result-*discovery* mechanism is what this task would change.
