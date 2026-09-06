#!/usr/bin/env python3
"""SpaceWorker extraction worker — core extraction logic (Task 2).

Pure Python; no FastAPI imports here. This module is the adapted version of the
original lead-extractor automation_server.py:
- The original broadcast() WebSocket callback is replaced by an injected
  on_progress async callback that receives one lead dict at a time.
- The DuckDuckGo path tries plain requests + BeautifulSoup FIRST (cheap, no
  Chromium). LIVE-TESTED during this rebuild against the real endpoint: it works
  for genuine results roughly half the time, but the other half DuckDuckGo serves
  its real "anomaly" anti-bot challenge (a real CAPTCHA, not a hard block) instead
  of `.result` markup — this is NOT the "confirmed no-CAPTCHA" outcome the
  conversion was originally scoped on. See duckduckgo_search_http()'s docstring
  and the handoff report for the full test data. Because of that,
  duckduckgo_search_playwright() is a real fallback (not dead code) that
  search_phase() uses whenever the lightweight path is blocked, so the RAM saving
  is real for the common case but the job doesn't just fail the other half.
- Google still uses Playwright (it genuinely needs a real browser for CAPTCHA
  handling). Every Chromium launch (Google or the DDG fallback) uses a fresh
  per-job throwaway profile inside that job's own directory — never a shared or
  long-lived profile — and shares one retry/reload-resilience helper
  (_resilient_page_content), adapted from the original engine's browser-launch
  fallback and reload-between-batches logic.

Entry point:
    run_automation(query, params, job_dir, on_progress) -> list[dict]

The Google path (and the DDG fallback path) require Playwright browsers installed:
    playwright install chromium
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Awaitable, Callable, Optional
from urllib.parse import parse_qs, quote_plus, unquote, urljoin

import requests
from bs4 import BeautifulSoup

# Relative imports — these resolve correctly when running from WorkingDirectory=.../worker
# (the systemd deploy config). The 'worker.' prefix would raise ModuleNotFoundError there.
from extractors.email_extractor import extract_emails as _extract_emails
from extractors.phone_extractor import extract_phones as _extract_phones
from extractors.name_extractor import (
    extract_business_name as _extract_business_name,
    extract_contact_names as _extract_contact_names,
    extract_names_from_email as _extract_names_from_email,
)
from filters.email_domain_rules import (
    email_matches_rules,
    parse_email_domain_allowlist,
)
from pypdf import PdfReader

def is_rdp_session() -> bool:
    """Ported verbatim from the original lead-extractor engine's is_rdp_session().

    Only ever true on win32; on this worker's Linux/systemd deploy it's always False,
    so it has no effect on behavior today. Kept (rather than deleted) because the
    worker's headless launch path always forces headless=True anyway — this exists
    purely so a future Windows deploy of this same worker doesn't silently regress
    the original engine's "force headless under RDP" safety behavior.
    """
    if sys.platform != "win32":
        return False
    session_name = os.environ.get("SESSIONNAME", "").upper()
    client_name = os.environ.get("CLIENTNAME", "")
    remote_session = os.environ.get("REMOTE_SESSION", "0")
    if session_name.startswith("RDP"):
        return True
    if client_name:
        return True
    if remote_session == "1":
        return True
    if os.environ.get("TERM_PROGRAM", "").upper() in ("RDP", "REMOTE"):
        return True
    return False


BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

REQUEST_TIMEOUT_SECONDS = 10

# Real-crawler (Task 13) defaults for the two user-configurable params, applied
# worker-side when a job doesn't send them (the upstream API/clamp logic generally
# forwards them, but this is the second, independent bound as with max_results).
DEFAULT_PAGES_PER_QUERY = 5
DEFAULT_MAX_DURATION_MINUTES = 30
# Google's results pagination moves in blocks of 10 (start=0,10,20,...). If Google
# ever changes this, only this constant needs touching.
GOOGLE_RESULTS_PER_PAGE = 10

AsyncCallable = Callable[[dict], Awaitable[None]]

# Task 14 live activity feed: a second, textual "current step" channel alongside
# the per-lead on_progress callback — "Searching: …", "Visiting page N …", "Reading
# a PDF at …". Async at the API boundary (matches on_progress); a plain sync adapter
# is used where the step fires inside a run_in_executor thread.
AsyncStepCallable = Callable[[str], Awaitable[None]]
SyncStepCallable = Callable[[str], None]


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


@dataclass
class AutomationResult:
    """run_automation's return value (Task 13).

    `status` is "done" when every query in the budget was processed (or the
    minimum-results target was reached) and "paused" when the run stopped early at
    a query boundary because of a manual pause or the max-duration deadline. When
    paused, `resume_state` records enough to continue without restarting from
    query #1 — see run_automation() for the shape.
    """
    leads: list[dict]
    status: str  # "done" | "paused"
    resume_state: Optional[dict] = None


# Content-Type variants search engines actually serve PDFs under — the continuous
# `application/pdf` is the overwhelmingly common one, but a HEAD check guards
# against PDFs served without a `.pdf` URL.
_PDF_CONTENT_TYPES = {
    "application/pdf",
    "application/x-pdf",
    "application/acrobat",
    "text/pdf",
}


def _decode_ddg_url(href: str) -> str:
    """DDG result <a> hrefs are redirect links. Decode the real destination URL."""
    if "uddg=" in href and "?" in href:
        qs = parse_qs(href.split("?", 1)[1])
        encoded = qs.get("uddg", [None])[0]
        if encoded:
            real = unquote(encoded)
            if real.startswith(("http://", "https://")):
                return real
    return href


def _absolute_url(maybe_relative: str, base: str) -> str:
    if maybe_relative.startswith(("http://", "https://")):
        return maybe_relative
    if maybe_relative.startswith("//"):
        return "https:" + maybe_relative
    return urljoin(base, maybe_relative)


class DDGBlockedError(Exception):
    """Raised when DuckDuckGo's plain-HTML endpoint serves its anti-bot 'anomaly'
    challenge instead of real results, so the caller can fall back to Playwright."""


_DDG_URL = "https://html.duckduckgo.com/html/"
_DDG_ANOMALY_MARKER = "anomaly-modal"  # DDG's actual CAPTCHA challenge div class


def _parse_ddg_html(html: str, base_url: str, max_results: int) -> list[SearchResult]:
    """Shared parser for both the plain-HTTP and Playwright-rendered DDG HTML — same
    page, same markup, so one selector set covers both paths (see module docstring)."""
    soup = BeautifulSoup(html, "lxml")
    results: list[SearchResult] = []
    for el in soup.select(".result"):
        a = el.select_one(".result__a")
        u = el.select_one(".result__url")
        s = el.select_one(".result__snippet")
        if not a or not u:
            continue
        raw_href = a.get("href", "").strip()
        if not raw_href:
            continue
        title = a.get_text(" ", strip=True)
        href = _absolute_url(raw_href, base_url)
        real_url = _decode_ddg_url(href)
        snippet = s.get_text(" ", strip=True) if s else ""
        results.append(SearchResult(title=title, url=real_url, snippet=snippet))
        if len(results) >= max_results:
            break
    return results[:max_results]


def duckduckgo_search_http(query: str, max_results: int) -> list[SearchResult]:
    """Plain-HTTP DuckDuckGo search. Blocking — run via run_in_executor.

    IMPORTANT — this is unreliable, confirmed by live testing against the real
    endpoint during this rebuild: across a small sample of realistic lead-gen
    queries (e.g. "plumbers in Chicago", "dentist new york"), DuckDuckGo served
    its real "Select all squares containing a duck" anti-bot challenge instead of
    results roughly half the time — HTTP 202 with an `anomaly-modal` challenge div,
    not the `.result` markup. This is NOT the "confirmed working, no-CAPTCHA" outcome
    this conversion was originally scoped on; it appears request-dependent (possibly
    IP-reputation and/or query-content based) rather than a hard block. Because of
    that, `search_phase()` below treats this as the fast/cheap FIRST attempt and
    falls back to `duckduckgo_search_playwright()` (a real headless browser) whenever
    this raises DDGBlockedError, rather than shipping the lightweight path as the
    sole mechanism. See the handoff report for the full test data.
    """
    resp = requests.get(
        _DDG_URL,
        params={"q": query},
        headers={"User-Agent": BROWSER_USER_AGENT},
        timeout=20,
    )
    resp.raise_for_status()
    if _DDG_ANOMALY_MARKER in resp.text:
        raise DDGBlockedError("DuckDuckGo served an anti-bot challenge page")
    return _parse_ddg_html(resp.text, _DDG_URL, max_results)


NAV_MAX_ATTEMPTS = 3
NAV_RETRY_DELAY_SECONDS = 3
# A soft, IP-based rate-throttle (as opposed to a hard CAPTCHA gate) can clear in
# tens of seconds — 3s (NAV_RETRY_DELAY_SECONDS) retries against the exact same
# throttle window are pointless. Not a fix for a durable IP-reputation block.
CAPTCHA_BACKOFF_SECONDS = 20


async def _launch_persistent_context(playwright, profile_dir: str):
    """Launch a persistent Chromium context, falling back to system Chrome if the
    bundled Chromium binary is missing (ENOENT/spawn failure) — ported from the
    original engine's browser-launch fallback (automation_server.py ~L642-662).

    Anti-detection hardening (added after DDG's own headless Chromium fallback
    started hitting the same 'anomaly-modal' challenge the plain-HTTP path was
    supposed to fall back FROM — confirmed via a real failed job): old-style
    `headless=True` is a well-known, strongly fingerprintable signal (missing
    GPU/plugin APIs a real browser has). `headless="new"` is Chromium's newer
    headless mode, built specifically to be much closer to a real headed
    browser and far less distinguishable. `navigator.webdriver` is patched to
    undefined (the single most common automation-detection check) via an
    init script, and a realistic desktop viewport/UA are set explicitly
    rather than left at Playwright's own defaults. This is a mitigation, not
    a guarantee — DDG's detection can still evolve, and a datacenter VPS IP
    making automated requests is a separate risk this doesn't address."""
    # NOTE: `headless="new"` is NOT valid here — Playwright's Python binding
    # (confirmed against the actual pinned 1.44.0) requires headless to be a
    # bool and throws "expected boolean, got string" otherwise, which would
    # have broken this launch entirely (verified empirically before landing
    # this fix, after an earlier draft got this wrong). The correct way to
    # opt into Chromium's new headless mode at this Playwright version is the
    # `--headless=new` command-line flag, with `headless=True` kept as-is —
    # also verified empirically (a real launch + page.goto succeeded).
    launch_kwargs = dict(
        headless=True,
        args=[
            "--no-sandbox", "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled", "--headless=new",
        ],
        user_agent=BROWSER_USER_AGENT,
        viewport={"width": 1366, "height": 768},
    )

    async def _harden(context):
        # webdriver undefined is the single most common check; plugins/languages/
        # permissions are ported from the original desktop engine's own
        # anti-detection script (automation_server.py ~L708-731) — a bare
        # Playwright context otherwise reports zero plugins and a permissions API
        # that behaves subtly differently from a real Chrome profile, both of
        # which are cheap, real signals a fingerprinting check can key on.
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters)
            );
        """)
        return context

    try:
        return await _harden(
            await playwright.chromium.launch_persistent_context(profile_dir, **launch_kwargs)
        )
    except Exception as e:
        err = str(e).lower()
        if "enoent" in err or "spawn" in err or "failed to launch" in err:
            return await _harden(
                await playwright.chromium.launch_persistent_context(
                    profile_dir, channel="chrome", **launch_kwargs
                )
            )
        raise


class _BlockedByCaptchaError(Exception):
    """A `captcha_markers` substring was found in the page — distinct from a plain
    navigation/network error so the retry loop below can give this its own, much
    longer backoff (a soft, IP-based rate-throttle can clear in tens of seconds;
    a 3s retry against the exact same block is pointless)."""


async def _resilient_page_content(profile_dir: str, url: str, captcha_markers: tuple[str, ...]) -> str:
    """Navigate to `url` in a fresh per-job persistent Chromium context and return
    page.content(). Retries navigation up to NAV_MAX_ATTEMPTS times (transient network
    hiccups), and — if every attempt in the first context fails — recreates the
    context once and retries again, adapting the original engine's browser-launch
    fallback + "reload between batches" resilience pattern (automation_server.py
    ~L642-662, ~L863-925) to this worker's single-query-per-job shape.

    On a CAPTCHA hit: the original desktop engine waits up to 60s for a HUMAN to
    solve it in a visible browser window on the user's own (typically residential)
    IP — there is no human and no window on this headless server worker, so that
    exact mechanism cannot port over. What DOES port over, and is applied here: a
    much longer backoff specifically for a captcha-marker match (CAPTCHA_BACKOFF_SECONDS,
    not the short NAV_RETRY_DELAY_SECONDS used for ordinary network hiccups) on the
    chance it's a soft, temporary rate-throttle rather than a hard block, plus a
    small human-like delay before every navigation (real users don't hit search
    pages back-to-back with zero delay). Neither of these can fix a durable
    datacenter-IP reputation problem — confirmed live 2026-09-06 that this VPS's
    IP gets captcha'd on the very first fresh-profile Google request — only a
    cleaner exit IP (see lib/exit-nodes.ts) actually addresses that root cause.
    """
    from playwright.async_api import async_playwright

    async def _one_attempt(context) -> str:
        # Human-like pacing before every navigation, not just retries — a bot
        # hitting Google instantly, back-to-back, is itself a detectable signal
        # the original engine avoids via its own `delay_between_actions` +
        # explicit "human-like pause" sleeps around each search.
        await asyncio.sleep(random.uniform(1.5, 3.5))
        page = await context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            content = await page.content()
            lowered = content.lower()
            for marker in captcha_markers:
                if marker.lower() in lowered:
                    raise _BlockedByCaptchaError(f"blocked: '{marker}' marker present")
            return content
        finally:
            try:
                await page.close()
            except Exception:
                pass

    async def _try_with_context(context) -> str:
        last_err: Optional[Exception] = None
        for attempt in range(1, NAV_MAX_ATTEMPTS + 1):
            try:
                return await _one_attempt(context)
            except Exception as e:
                last_err = e
                if attempt < NAV_MAX_ATTEMPTS:
                    delay = CAPTCHA_BACKOFF_SECONDS if isinstance(e, _BlockedByCaptchaError) else NAV_RETRY_DELAY_SECONDS
                    await asyncio.sleep(delay)
        raise last_err or RuntimeError("navigation failed")

    async with async_playwright() as p:
        context = await _launch_persistent_context(p, profile_dir)
        try:
            try:
                return await _try_with_context(context)
            except Exception:
                # All NAV_MAX_ATTEMPTS attempts failed in this context — recreate it
                # fresh once (matches the original's "reload failed - retrying
                # context creation" fallback) before giving up.
                try:
                    await context.close()
                except Exception:
                    pass
                context = await _launch_persistent_context(p, profile_dir)
                return await _try_with_context(context)
        finally:
            try:
                await context.close()
            except Exception:
                pass


async def duckduckgo_search_playwright(query: str, max_results: int, job_dir: str) -> list[SearchResult]:
    """Fallback DDG path via a real headless browser, used when the plain-HTTP path
    (duckduckgo_search_http) hits the anti-bot challenge. Same URL, same selectors —
    just fetched through Chromium instead of `requests` for a more convincing fingerprint."""
    profile_dir = os.path.join(job_dir, "ddg-profile")
    url = _DDG_URL + "?q=" + quote_plus(query)
    content = await _resilient_page_content(profile_dir, url, captcha_markers=(_DDG_ANOMALY_MARKER,))
    return _parse_ddg_html(content, _DDG_URL, max_results)


async def google_search(
    query: str, max_results: int, job_dir: str, start: int = 0
) -> tuple[list[SearchResult], bool]:
    """Playwright Google search with a per-job throwaway profile.

    `start` is Google's pagination offset (0,10,20,... — see
    GOOGLE_RESULTS_PER_PAGE). Callers wanting more than one page should use
    google_search_paginated() rather than driving this in a raw loop themselves.

    Returns (results, has_next_page). has_next_page is read from Google's own
    "Next" pagination control (`#pnnext`, or `a[aria-label]` containing "next"
    on markup variants that drop that id) — NOT inferred from the parsed
    organic-result count, which undercounts on pages with ads/"People also
    ask"/knowledge panels squeezing out organic results below a full page's
    worth even though more result pages genuinely exist.
    """
    profile_dir = os.path.join(job_dir, "chrome-profile")
    url = "https://www.google.com/search?q=" + quote_plus(query)
    if start > 0:
        url += "&start=" + str(start)
    content = await _resilient_page_content(
        profile_dir, url, captcha_markers=("unusual traffic", "captcha"),
    )
    soup = BeautifulSoup(content, "lxml")
    results: list[SearchResult] = []
    for el in soup.select("div.g, div[data-hveid]"):
        h3 = el.select_one("a h3")
        if not h3:
            continue
        a = el.select_one("a")
        href = a.get("href") if a else None
        url_ = _absolute_url(href or "", "https://www.google.com/")
        snippet_el = el.select_one("div.VwiC3b, div[data-sncf]")
        title = h3.get_text(" ", strip=True)
        snippet = snippet_el.get_text(" ", strip=True) if snippet_el else ""
        results.append(SearchResult(title=title, url=url_, snippet=snippet))
        if len(results) >= max_results:
            break
    next_link = soup.select_one("#pnnext")
    if next_link is None:
        next_link = soup.select_one('a[aria-label*="ext" i]')
    return results[:max_results], next_link is not None


async def google_search_paginated(
    query: str, max_results: int, pages_per_query: int, job_dir: str,
    on_step: Optional[AsyncStepCallable] = None,
) -> list[SearchResult]:
    """Drive Google's paged results over up to `pages_per_query` pages.

    Google's pagination is a `start=` offset in multiples of 10
    (GOOGLE_RESULTS_PER_PAGE) — request each page, dedup across pages by URL, and
    stop once Google's own "Next" control is gone (confirmed real end-of-results,
    not just a light page) or the caller's `max_results` cap has been reached.
    Each page uses the shared per-job throwaway Chromium profile via
    google_search() (no second browser-launch path introduced here).
    """
    seen_urls: set[str] = set()
    all_results: list[SearchResult] = []
    for page_index in range(max(1, pages_per_query)):
        # Task 14 live activity: expose which result page we're on so the UI can
        # show a slow multi-page crawl is actually moving, not stalled.
        if on_step is not None:
            await on_step(f"Visiting page {page_index + 1} of Google results")
        start = page_index * GOOGLE_RESULTS_PER_PAGE
        page_results, has_next = await google_search(query, max_results, job_dir, start=start)
        new_results: list[SearchResult] = []
        for r in page_results:
            if r.url in seen_urls:
                continue
            seen_urls.add(r.url)
            new_results.append(r)
        all_results.extend(new_results)
        if not has_next or len(all_results) >= max_results:
            break
    return all_results[:max_results]


# Ported from the original desktop engine (automation_server.py ~L953-958),
# confirmed as the actual reason it reliably surfaced PDFs: it does not wait for
# an ordinary organic result to happen to be a PDF (which for a plain business-
# directory query like "plumbers in texas" it almost never is) — it appends
# `filetype:pdf` to the query ITSELF, so the search engine's own ranking returns
# results that are overwhelmingly PDFs. Applied to both Google and DuckDuckGo
# queries, exactly as the original does for its default (non-Reddit-only) mode.
MAX_DDG_QUERY_CHARS = 420


def _bias_query_toward_pdfs(query: str) -> str:
    q = query.strip()
    if "filetype:pdf" not in q.lower() and "filetype: pdf" not in q.lower():
        q = f"{q} filetype:pdf"
    if len(q) > MAX_DDG_QUERY_CHARS:
        q = q[:MAX_DDG_QUERY_CHARS].strip()
    return q


async def search_phase(query: str, params: dict, job_dir: str,
                       on_step: Optional[AsyncStepCallable] = None) -> list[SearchResult]:
    engine = params.get("engine", "duckduckgo")
    # Confirmed against the real caller (app/dashboard/extract/page.tsx sends
    # `params: { engine, maxResults }`, camelCase) — the dispatcher's own
    # `POST /api/jobs` clamps this server-side to 10-200 before it ever reaches
    # here, so this worker-side max(1, min(..., 50)) is a second, independent
    # bound, not the source of truth for the real limit.
    max_results = int(params.get("maxResults", 10))
    max_results = max(1, min(max_results, 50))

    if engine == "google":
        # Real crawler (Task 13): visit multiple result pages per query, bounded
        # independently the same way max_results is. pagesPerQuery is clamped
        # upstream (1-20) but re-bounded here as the second check.
        raw_pages = params.get("pagesPerQuery", DEFAULT_PAGES_PER_QUERY)
        try:
            pages_per_query = max(1, min(int(raw_pages), 20))
        except (ValueError, TypeError):
            pages_per_query = DEFAULT_PAGES_PER_QUERY
        pdf_query = _bias_query_toward_pdfs(query)
        try:
            return await google_search_paginated(pdf_query, max_results, pages_per_query, job_dir, on_step)
        except _BlockedByCaptchaError:
            # Google is durably blocking this IP for this query (already retried
            # with backoff inside _resilient_page_content) — the original desktop
            # engine's own advice for exactly this case is "try DuckDuckGo instead"
            # (it has no human here to solve the checkbox either, so this is the
            # equivalent: don't fail the whole query, fall through to the other
            # engine rather than returning zero results for it).
            if on_step is not None:
                await on_step(f"Google blocked — falling back to DuckDuckGo for: {query}")
            loop = asyncio.get_event_loop()
            try:
                return await loop.run_in_executor(None, duckduckgo_search_http, pdf_query, max_results)
            except DDGBlockedError:
                return await duckduckgo_search_playwright(pdf_query, max_results, job_dir)

    pdf_query = _bias_query_toward_pdfs(query)
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, duckduckgo_search_http, pdf_query, max_results)
    except DDGBlockedError:
        # Confirmed-real fallback (see duckduckgo_search_http docstring) — the
        # lightweight path is blocked for this request, so pay the Chromium cost
        # this one time rather than failing the whole job.
        return await duckduckgo_search_playwright(pdf_query, max_results, job_dir)


def _build_leads(
    result: SearchResult,
    emails: list[str],
    phones: list[str],
    contact_names: list[str],
) -> list[dict]:
    """Turn one page's extracted emails/phones/names into 0..N lead dicts.

    Mirrors the original engine's convention (automation_server.py's extract_from_pdf,
    ~L401-435): one lead PER EMAIL (email/phone/contactName are singular strings there —
    TASK_03_QUEUE_AND_LANES.md's Prisma `Lead` model declares `email String?` and
    `phone String?`, not arrays), falling back to a single phone/name-only lead when no
    email was found at all, and to nothing when none of the three were found.
    """
    business_name = _extract_business_name(result.title, result.url, result.snippet)
    common = {
        "businessName": business_name,
        "website": result.url,
        "sourceUrl": result.url,
        "snippet": result.snippet,
    }

    if emails:
        leads = []
        for i, email in enumerate(emails):
            contact_name = contact_names[i] if i < len(contact_names) else (
                contact_names[0] if contact_names else None
            )
            phone = phones[i] if i < len(phones) else (phones[0] if phones else None)
            leads.append({
                "email": email,
                "phone": phone,
                "contactName": contact_name,
                **common,
            })
        return leads

    if phones or contact_names:
        return [{
            "email": None,
            "phone": phones[0] if phones else None,
            "contactName": contact_names[0] if contact_names else None,
            **common,
        }]

    return []


def extract_lead_page(result: SearchResult) -> list[dict]:
    """Fetch one result page and extract email/phone/name metadata as 0..N leads.

    Note (Task 13): a page that can't be fetched OR that is genuinely empty of
    extractable contact info yields zero leads — the old behavior of guessing an
    email/phone/name from the search-results *snippet* when the real page had
    nothing was producing junk leads (fake-looking names/phones pulled from an
    unrelated page's bio text), which is exactly what this task's user flagged.
    Task 13 verification requires "no snippet-derived guesses".
    """
    try:
        resp = requests.get(
            result.url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        html = resp.text
    except Exception:
        # Page unreachable — produce no leads rather than guessing from the snippet.
        return []

    soup = BeautifulSoup(html, "lxml")
    page_text = soup.get_text(" ", strip=True)

    # Use dedicated extractors — they handle mailto: links, junk-domain
    # filtering, and false-extension removal so automation.py has no
    # parallel implementations that could silently drift.
    emails = _extract_emails(page_text, html)
    phones = _extract_phones(page_text, html)

    # Best-effort contact name(s): try structured patterns in page text first,
    # then fall back to guessing from each email's local-part.
    contact_names = _extract_contact_names(page_text)
    if emails and not contact_names:
        contact_names = [n for n in (_extract_names_from_email(e) for e in emails) if n]

    return _build_leads(result, emails, phones, contact_names)


def _is_pdf_result(result: SearchResult) -> bool:
    """Cheap-reliable PDF detection before deciding which extractor to run.

    Prefer the URL ending in `.pdf` (case-insensitive, ignoring a trailing query
    string/path segment) first, then a HEAD request's Content-Type so PDFs served
    without a `.pdf` URL are still caught. Some servers/CDNs reject or time out on
    HEAD (405, connection reset) even for a real PDF — falling straight through to
    "not a PDF" on any HEAD failure would silently route those into the HTML
    extractor, which BeautifulSoup-parses raw PDF bytes as garbage text and finds
    nothing. On a HEAD failure, fall back to a streamed GET, checked by
    Content-Type first and by the `%PDF-` magic bytes if that's still ambiguous
    (some servers mislabel PDFs as application/octet-stream) — closed immediately
    either way, since the real extraction re-fetches in extract_lead_pdf().
    """
    path = result.url.lower().split("?", 1)[0].rstrip("/")
    if path.endswith(".pdf"):
        return True
    try:
        resp = requests.head(
            result.url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=5,
            allow_redirects=True,
        )
        content_type = resp.headers.get("Content-Type", "").lower().split(";")[0].strip()
        if content_type in _PDF_CONTENT_TYPES:
            return True
        if content_type and content_type not in ("application/octet-stream", "binary/octet-stream"):
            return False  # server gave an unambiguous non-PDF answer — trust it
    except Exception:
        pass  # HEAD unsupported/failed — fall through to a real GET below
    try:
        with requests.get(
            result.url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=5,
            stream=True,
        ) as resp:
            content_type = resp.headers.get("Content-Type", "").lower().split(";")[0].strip()
            if content_type in _PDF_CONTENT_TYPES:
                return True
            magic = next(resp.iter_content(chunk_size=5), b"")
            return magic == b"%PDF-"
    except Exception:
        return False


def extract_lead_pdf(result: SearchResult) -> list[dict]:
    """Download a PDF result, extract its text, and produce 0..N leads.

    Reuses the exact same _build_leads/_extract_* pipeline extract_lead_page()
    uses on HTML text — no parallel extraction implementation for PDF text. A PDF
    that can't be fetched or parsed (corrupt/encrypted/scanned-image-only, or
    pypdf unavailable) yields zero leads rather than crashing the job.
    """
    try:
        resp = requests.get(
            result.url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        reader = PdfReader(BytesIO(resp.content))
        if reader.is_encrypted:
            return []
        # Collect across all pages — try/except per page so one bad page doesn't
        # discard the whole document's text.
        page_texts: list[str] = []
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if text.strip():
                page_texts.append(text)
        pdf_text = "\n".join(page_texts)
    except Exception:
        return []

    if not pdf_text.strip():
        return []

    emails = _extract_emails(pdf_text)
    phones = _extract_phones(pdf_text)
    contact_names = _extract_contact_names(pdf_text)
    if emails and not contact_names:
        contact_names = [n for n in (_extract_names_from_email(e) for e in emails) if n]
    return _build_leads(result, emails, phones, contact_names)


def _extract_result(result: SearchResult,
                    on_step: Optional[SyncStepCallable] = None) -> list[dict]:
    """Dispatch one search result to the right extractor (PDF vs real page).

    Shared by _search_and_extract() for every result on every page — keeps the
    PDF/HTML branching in exactly one place. Never guesses from the search snippet:
    a result with no real extractable content (HTML or PDF) simply yields no leads.

    Task 14: `on_step` is a plain *sync* reporter (not the async on_step passed
    around elsewhere) because this function runs in a run_in_executor thread and
    therefore can't await; _search_and_extract() hands it a thread-safe adapter.
    """
    try:
        if _is_pdf_result(result):
            if on_step is not None:
                on_step(f"Reading a PDF at {result.url}")
            return extract_lead_pdf(result)
        if on_step is not None:
            on_step(f"Extracting a page at {result.url}")
        return extract_lead_page(result)
    except Exception:
        return []


# Minimum-results auto-expansion (Task: "keep adding related words until we
# hit the minimum"). Deterministic, no external API/LLM dependency — appends
# generic qualifier suffixes to each ORIGINAL base term to generate new search
# variants, one suffix per round (so the outer loop's between-round "have we
# hit the minimum yet" check actually has a chance to stop early instead of
# every suffix being dumped into a single first round). Bounded on both axes
# (rounds = len(_EXPANSION_SUFFIXES), and total query count) so a
# never-satisfiable minimum (e.g. minResults=10000) can't loop indefinitely or
# hammer the search engine.
_EXPANSION_SUFFIXES = [" near me", " company", " services", " LLC"]
MAX_EXPANSION_ROUNDS = len(_EXPANSION_SUFFIXES)
MAX_TOTAL_QUERIES = 20


def _expand_queries_for_round(base_terms: list[str], suffix: str, already_used: set[str]) -> list[str]:
    """One round's worth of expansion: base_terms + this round's single
    suffix, skipping anything already searched in an earlier round."""
    expanded: list[str] = []
    for term in base_terms:
        candidate = f"{term}{suffix}"
        if candidate not in already_used:
            expanded.append(candidate)
    return expanded


async def _search_and_extract(
    query_list: list[str],
    params: dict,
    job_dir: str,
    on_progress: AsyncCallable,
    seen_urls: set[str],
    domain_rules,
    on_step: Optional[AsyncStepCallable] = None,
) -> list[dict]:
    """One pass: search every term in query_list, dedup against the SHARED
    seen_urls set (so a later expansion round never reprocesses a page an
    earlier round already extracted), then extract leads concurrently.
    Factored out of run_automation so the min-results loop can call this
    once per expansion round without duplicating the search/extract logic.

    Task 14: on_step (threaded the same way as on_progress — no different
    plumbing) reports the current crawler step just before each search so the
    UI's "Currently: …" line tracks what the job is doing right now.
    """
    loop = asyncio.get_event_loop()

    if len(query_list) == 1:
        # Single-query path: preserve the original failure semantics — a solo
        # query's own search failure propagates instead of being swallowed.
        if on_step is not None:
            await on_step(f"Searching: {query_list[0]}")
        results = await search_phase(query_list[0], params, job_dir, on_step)
    else:
        # Multi-query path: a blocked/erroneous term shouldn't abort the whole
        # job, so each term is isolated via return_exceptions and a failure
        # just contributes zero results rather than crashing the job. Run
        # concurrently — each search_phase call can take tens of seconds.
        async def _search_one(q: str) -> list[SearchResult]:
            if on_step is not None:
                await on_step(f"Searching: {q}")
            return await search_phase(q, params, job_dir, on_step)

        per_query_results = await asyncio.gather(
            *(_search_one(q) for q in query_list),
            return_exceptions=True,
        )
        results = []
        for r in per_query_results:
            if isinstance(r, Exception):
                continue
            results.extend(r)

    unique_results: list[SearchResult] = []
    for r in results:
        if r.url not in seen_urls:
            seen_urls.add(r.url)
            unique_results.append(r)

    async def process_one(result: SearchResult) -> list[dict]:
        # Dispatches PDF results to extract_lead_pdf and everything else to
        # extract_lead_page — see _extract_result. Both reuse the same extract.
        # Task 14: _extract_result now also reports which result it's working on
        # (PDF vs real page). It runs in an executor thread, so give it a plain
        # *sync* adapter that schedules the async on_step back onto this job's
        # event loop without blocking the extraction.
        def report_step_sync(text: str) -> None:
            if on_step is not None:
                asyncio.run_coroutine_threadsafe(on_step(text), loop)

        leads = await loop.run_in_executor(None, _extract_result, result, report_step_sync)
        kept: list[dict] = []
        for lead in leads:
            # Filter at the point of emission so on_progress stream and final list
            # stay in sync — leads that don't match are never stored or returned.
            if domain_rules is not None and not domain_rules.is_empty():
                if not email_matches_rules(lead.get("email") or "", domain_rules):
                    continue
            await on_progress(lead)
            kept.append(lead)
        return kept

    # return_exceptions=True so one failed page (malformed markup, name-extractor
    # error, etc.) doesn't abort the entire batch — other results still land.
    leads_per_result = await asyncio.gather(
        *[process_one(r) for r in unique_results],
        return_exceptions=True,
    )
    all_leads: list[dict] = []
    for item in leads_per_result:
        if isinstance(item, list):
            all_leads.extend(item)
    return all_leads


def _build_ordered_queries(base_terms: list[str], min_results: int | None) -> list[str]:
    """Deterministic full query budget: original base terms first, then one
    expansion suffix across all base terms per round (the same "one suffix at a
    time" cadence the previous between-round minimum check relied on), deduped and
    capped at MAX_TOTAL_QUERIES. Expansion suffixes only appear when min_results is
    set — mirroring the old "only expand when min_results > 0" gating. The caller's
    loop then stops as soon as the minimum is reached instead of exhausting the
    budget, preserving the early-stop behavior.
    """
    ordered: list[str] = []
    used: set[str] = set()

    def _add(terms: list[str]) -> None:
        for t in terms:
            if t not in used:
                used.add(t)
                ordered.append(t)

    _add(base_terms)
    if min_results is not None and min_results > 0:
        for suffix in _EXPANSION_SUFFIXES:
            _add(_expand_queries_for_round(base_terms, suffix, used))
            if len(ordered) >= MAX_TOTAL_QUERIES:
                break
    return ordered[:MAX_TOTAL_QUERIES]


async def run_automation(
    query: str,
    params: dict,
    job_dir: str,
    on_progress: AsyncCallable,
    should_stop: Optional[Callable[[], Awaitable[bool]]] = None,
    on_step: Optional[AsyncStepCallable] = None,
) -> AutomationResult:
    """Run a full extraction job: search then per-result extraction.

    Multi-term support (Lead Extractor templates): when `params["queries"]` is a
    non-empty list of strings (e.g. the chips a user adds — "plumber", "carpenter"),
    every term is searched and the results are combined before dedup, so one job
    genuinely searches across all of the user's "Find" items, not just the first.

    Real crawler (Task 13): for each term, google_search_paginated (via
    search_phase -> _search_and_extract) visits up to `pagesPerQuery` Google result
    pages, and each result is either click-through-extracted from its real page
    content (extract_lead_page) or, for PDFs, from the PDF's extracted text
    (extract_lead_pdf). No snippet-metadata guessing.

    Task 14: `on_step` (optional) reports the current crawler step as a short
    text string — "Searching: …", "Visiting page N …", "Reading a PDF at …",
    "Extracting a page at …" — before each meaningful step so a long crawl reads
    as alive in the UI. It's threaded exactly like on_progress
    (run_automation -> _search_and_extract -> search_phase /
    google_search_paginated / _extract_result); nothing here changes how leads
    are found, extracted, or persisted.

    Minimum-results auto-expansion: when `params["minResults"]` is a positive number,
    _build_ordered_queries precomputes the ordered base+expansion query budget and
    the loop stops as soon as the minimum is met; leads accumulate (deduped by URL
    via the shared seen_urls set); on_progress fires for every lead as found.

    Pause / max-duration (resumable jobs): the loop processes exactly one query per
    iteration and checks `should_stop()` AND the wall-clock deadline ONLY at query
    boundaries (never mid-query, matching the user's "pause means it stops at that
    certain query"). When either fires, run_automation returns normally (not
    raise/cancel) with status "paused" plus a resume_state payload so worker/api.py
    can persist all leads found so far and a later resume continues from the next
    unprocessed query instead of restarting from query #1.
    """
    raw_queries = params.get("queries")
    if (
        isinstance(raw_queries, list)
        and len(raw_queries) > 0
        and all(isinstance(q, str) and q.strip() for q in raw_queries)
    ):
        base_terms: list[str] = [str(q).strip() for q in raw_queries]
    else:
        base_terms = [query]

    # Accepts int/float/numeric-string; floors decimals rather than silently
    # disabling expansion for them (an earlier draft's str.isdigit() check
    # rejected "10.5" entirely, since isdigit() is False for any decimal).
    raw_min_results = params.get("minResults")
    min_results: int | None = None
    if isinstance(raw_min_results, (int, float, str)):
        try:
            min_results = int(float(raw_min_results))
        except (ValueError, TypeError):
            min_results = None

    raw_domain_rules = params.get("emailDomains") or params.get("email_domains")
    domain_rules = parse_email_domain_allowlist(str(raw_domain_rules)) if raw_domain_rules else None

    # Full deterministic query budget (base terms + expansion variants when a
    # minimum is set) — the ordered list resume/nextQueryIndex index into.
    ordered_queries = _build_ordered_queries(base_terms, min_results)

    seen_urls: set[str] = set()
    all_leads: list[dict] = []

    # -- Resume hooks: skip queries already fully processed in a prior paused run
    # and seed the URL dedup + found-lead count so a resumed job neither re-emits
    # duplicates nor wrongly re-expands past the minimum it already reached.
    resume_state = params.get("resumeState")
    start_index = 0
    prior_found = 0
    if isinstance(resume_state, dict):
        idx = resume_state.get("nextQueryIndex")
        if isinstance(idx, int) and idx > 0:
            start_index = min(idx, len(ordered_queries))
        prior_found_raw = resume_state.get("foundLeads")
        if isinstance(prior_found_raw, int) and prior_found_raw > 0:
            prior_found = prior_found_raw
        prior_seen = resume_state.get("seenUrls")
        if isinstance(prior_seen, list):
            for u in prior_seen:
                if isinstance(u, str):
                    seen_urls.add(u)

    # -- Max-duration cap: wall-clock deadline checked at each query boundary
    # (behaves exactly like a pause when hit, so a duration-capped job can still be
    # resumed later rather than treated as a failure).
    raw_duration = params.get("maxDurationMinutes")
    max_duration_minutes = DEFAULT_MAX_DURATION_MINUTES
    if isinstance(raw_duration, (int, float, str)):
        try:
            parsed = int(float(raw_duration))
            if parsed > 0:
                max_duration_minutes = parsed
        except (ValueError, TypeError):
            pass
    deadline = time.monotonic() + max_duration_minutes * 60

    paused = False
    stopped_at = len(ordered_queries)

    for qi in range(start_index, len(ordered_queries)):
        term = ordered_queries[qi]
        # Query-boundary stop checks — the ONLY place pause/deadline are observed.
        if min_results is not None and min_results > 0 and prior_found + len(all_leads) >= min_results:
            break  # minimum reached — normal completion
        if should_stop is not None and await should_stop():
            paused = True
            stopped_at = qi
            break
        if time.monotonic() >= deadline:
            paused = True
            stopped_at = qi
            break

        try:
            leads = await _search_and_extract(
                [term], params, job_dir, on_progress, seen_urls, domain_rules, on_step
            )
            all_leads.extend(leads)
        except Exception:
            # One bad query (search blocked, engine error) shouldn't abort the whole
            # job — same isolation the old multi-query gather's return_exceptions
            # provided. Resume state will happily skip a query that errored.
            continue

    if paused:
        return AutomationResult(
            leads=all_leads,
            status="paused",
            resume_state={
                "processedQueries": ordered_queries[:stopped_at],
                "nextQueryIndex": stopped_at,
                "seenUrls": sorted(seen_urls),
                "foundLeads": prior_found + len(all_leads),
            },
        )
    return AutomationResult(leads=all_leads, status="done", resume_state=None)
