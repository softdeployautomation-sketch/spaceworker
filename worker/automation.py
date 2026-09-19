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
import itertools
import os
import random
import re
import shutil
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from io import BytesIO
from typing import Awaitable, Callable, Optional
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

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
from filters.webmail_platforms import (
    apply_webmail_bias_to_query,
    candidate_webmail_urls,
    detect_webmail_platform,
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

# Generous but FINITE cap on one result's total processing time (main page
# fetch, plus its PDF-detection HEAD/GET fallback, plus any embedded-PDF/
# contact-page sub-fetches) -- well above REQUEST_TIMEOUT_SECONDS to allow for
# a legitimate multi-request sequence, far below the 10+ minute real hang this
# was written to fix. See process_one()'s own comment for the full story.
PER_RESULT_HARD_TIMEOUT_SECONDS = 60

# Task 22/24: a DEDICATED, generously-sized thread pool for search dispatch and
# per-result extraction (PDF download + parse, page fetch), used everywhere
# below instead of the implicit default executor (`run_in_executor(None, ...)`).
# Confirmed live to be the dominant remaining bottleneck after every other
# fix this session: this box has only 4 CPUs, so Python's default executor
# sizing (`min(32, cpu_count+4)`) caps out at just 8 worker threads. Task 22's
# query-level batching (QUERY_BATCH_SIZE concurrent queries) STACKS on top of
# each query's own existing per-result concurrency (every result on one
# query's search already runs concurrently) -- one real batch can submit 100+
# extraction tasks at once, all sharing that same 8-thread pool. Verified
# directly: running one query in isolation (no concurrent siblings) got 1969
# leads in 78s -- close to the standalone's 2493 for the identical query --
# while the same query bundled into a real 5-wide batch got a small fraction
# of that, with many "Skipped (timed out after 60s)" entries on exactly the
# biggest, richest documents (the ones that take longest to download). The
# 60s-per-result timeout is measured from dispatch, not from when a thread
# actually starts the work -- a task stuck 55s deep in an 8-thread queue times
# out even if its own real download+parse would only take a few seconds.
# These tasks are I/O-bound (network download) with moderate CPU parsing on
# top, not CPU-bound number-crunching, so a much larger pool is safe on a
# 4-CPU box -- confirmed live, CPU usage stayed well under 50% even under the
# heaviest tested load. 128 comfortably covers a full batch's realistic
# result count (QUERY_BATCH_SIZE=5 x ~25 typical results/query) without
# queueing delay dominating the timeout budget.
_EXTRACTION_EXECUTOR = ThreadPoolExecutor(max_workers=128, thread_name_prefix="extract")

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

# Task 17: a result's own page can link out to many documents; bound how many
# embedded-PDF links we follow per page rather than pulling them all (each is a
# separate GET + pypdf parse). Not user-configurable this pass — a fixed,
# reasonable default is enough; revisit only if real usage shows 3 is too low.
_MAX_EMBEDDED_PDFS_PER_PAGE = 3

# Task 18: same-domain contact/about-style links on a result page are followed and
# their text folded into the extraction blob -- many real sites keep contact info on
# a /contact or /about sub-page, not the page that shows up in search results. The
# standalone desktop extractor's proven "Deep search" behavior. Not user-configurable
# this pass -- a fixed, reasonable default is enough; revisit only if real usage
# shows 5 is too low.
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
# A second, DIFFERENT block-page DDG serves specifically to headless/automated
# browsers (confirmed live 2026-09-11, via a real Task 20 validation test: 3/3
# headless-Chromium requests got this page, 0/3 got the anomaly-modal one) --
# a stripped error page, not the CAPTCHA modal, so the marker above alone
# silently missed it and would have returned zero results with no indication
# why. Checked as a tuple everywhere _DDG_ANOMALY_MARKER was checked alone.
_DDG_BLOCK_MARKERS = (_DDG_ANOMALY_MARKER, "if this persists, please email us")


def _is_ddg_block_page(content: str) -> bool:
    lowered = content.lower()
    return any(marker in lowered for marker in _DDG_BLOCK_MARKERS)


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
    # 403/429 from DDG's plain-HTTP endpoint is a block/rate-limit response, not a
    # generic server error -- confirmed live 2026-09-11 (a real 403 was hit
    # mid-testing). Previously this went straight to resp.raise_for_status(),
    # raising a plain requests.HTTPError that neither of search_phase()'s two
    # `except DDGBlockedError:` handlers catch, so the Playwright/exit-node
    # fallback chain never ran -- the query just silently counted as one
    # generic failure toward run_automation's consecutive-failure pause instead
    # of getting the same graceful fallback a content-marker-detected block gets.
    if resp.status_code in (403, 429):
        raise DDGBlockedError(f"DuckDuckGo returned HTTP {resp.status_code} (rate-limited/blocked)")
    resp.raise_for_status()
    if _is_ddg_block_page(resp.text):
        raise DDGBlockedError("DuckDuckGo served an anti-bot challenge page")
    return _parse_ddg_html(resp.text, _DDG_URL, max_results)


NAV_MAX_ATTEMPTS = 3
NAV_RETRY_DELAY_SECONDS = 3
# A soft, IP-based rate-throttle (as opposed to a hard CAPTCHA gate) can clear in
# tens of seconds — 3s (NAV_RETRY_DELAY_SECONDS) retries against the exact same
# throttle window are pointless. Not a fix for a durable IP-reputation block.
CAPTCHA_BACKOFF_SECONDS = 20

# Task 18 #4: a bounded, best-effort reCAPTCHA v2 checkbox solve. These bounds
# keep the whole solve effectively constant-time per attempt, so one stubborn
# page can't exceed the existing NAV_MAX_ATTEMPTS / backoff budget for its query.
CAPTCHA_CHECKBOX_SELECTOR = ".recaptcha-checkbox-border"
CAPTCHA_SOLVE_SETTLE_SECONDS = 4.0   # allow the verify spinners to settle
CAPTCHA_SOLVE_ATTEMPTS = 2           # one real click + one re-check after a wait


def _get_exit_nodes() -> list[dict]:
    """Python-side equivalent of lib/exit-nodes.ts's listExitNodes() — SpaceWorker's
    own self-hosted SOCKS5 exit nodes (dedicated Fly.io Machines relayed onto this
    host via microsocks/socat on 172.17.0.1, reachable from any host process).

    Same env var names (EXIT_NODE_US / EXIT_NODE_CA / EXIT_NODE_UK) and same
    `scheme://host:port` format as the Next.js side, so both halves of the app are
    configured from one set of values on the box. Any node whose env var is unset is
    skipped (matching listExitNodes()'s own filtering) — exactly like that side, we
    still check UK in case it's added later, but only US+CA resolve today.

    These are a LAST-RESORT fallback for when the worker's own IP is confirmed
    blocked — never the default routing for ordinary requests.
    """
    nodes: list[dict] = []
    for env_key, label in (("EXIT_NODE_US", "US"), ("EXIT_NODE_CA", "CA"), ("EXIT_NODE_UK", "UK")):
        raw = os.environ.get(env_key, "").strip()
        if not raw:
            continue
        m = re.match(r"^([a-z0-9]+)://([^:/]+):(\d+)$", raw, re.I)
        if not m:
            continue
        nodes.append({"label": label, "scheme": m.group(1), "host": m.group(2), "port": int(m.group(3))})
    return nodes


async def _launch_persistent_context(playwright, profile_dir: str, proxy: Optional[dict] = None):
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
    if proxy is not None:
        # Playwright's native SOCKS5 proxy support — used to route a blocked
        # request through SpaceWorker's own exit nodes (lib/exit-nodes.ts) without
        # needing any new Python dependency. For the common, direct-IP path proxy
        # is None and this key is never set, so behavior is byte-for-byte unchanged.
        launch_kwargs["proxy"] = {"server": f"{proxy['scheme']}://{proxy['host']}:{proxy['port']}"}

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
        for _ in range(CAPTCHA_SOLVE_ATTEMPTS):
            checkbox = page.locator(CAPTCHA_CHECKBOX_SELECTOR).first
            if not await checkbox.count():
                return False                    # not a checkbox challenge — not solvable here
            await checkbox.click()
            await page.wait_for_timeout(int(CAPTCHA_SOLVE_SETTLE_SECONDS * 1000))
            still = await page.locator(CAPTCHA_CHECKBOX_SELECTOR).count()
            grid = await page.locator(".rc-anchor-container, .fbc-imageselect").count()
            if (not still) and (not grid):
                return True                     # checkbox gone AND no grid = cleared
            if grid:
                return False                    # an image-grid appeared — not solvable here
        return False
    except Exception:
        return False


async def _resilient_page_content(profile_dir: str, url: str, captcha_markers: tuple[str, ...], proxy: Optional[dict] = None) -> str:
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
                    # Task 18 #4: actually TRY to clear the (widget-level) challenge
                    # first — clicking a reCAPTCHA v2 checkbox a real user would clear
                    # in ~1s. Only fall through to 'blocked' when it can't be solved.
                    if await _try_solve_recaptcha(page):
                        content = await page.content()  # re-read after a successful solve
                        break
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
        context = await _launch_persistent_context(p, profile_dir, proxy=proxy)
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
                context = await _launch_persistent_context(p, profile_dir, proxy=proxy)
                return await _try_with_context(context)
        finally:
            try:
                await context.close()
            except Exception:
                pass


async def duckduckgo_search_playwright(query: str, max_results: int, job_dir: str, proxy: Optional[dict] = None) -> list[SearchResult]:
    """Fallback DDG path via a real headless browser, used when the plain-HTTP path
    (duckduckgo_search_http) hits the anti-bot challenge. Same URL, same selectors —
    just fetched through Chromium instead of `requests` for a more convincing fingerprint.

    When `proxy` is a SpaceWorker exit node (see lib/exit-nodes.ts), the request is
    routed through that node's SOCKS5 and a SEPARATE per-node throwaway profile
    (`ddg-profile-us`/`ddg-profile-ca`) is used instead of the shared `ddg-profile` —
    so cookies/session state from the direct-IP requests never leak into what
    DuckDuckGo sees as a different visitor (and vice versa).

    Task 22/24: `profile_dir` gets a fresh uuid suffix EVERY call — Task 22 made
    run_automation call this (and its siblings below) up to QUERY_BATCH_SIZE times
    CONCURRENTLY within one job, but this function's profile_dir used to be a
    single fixed path per job_dir. Confirmed live: 5 concurrent calls sharing one
    profile directory means Chromium's persistent-context lock on that directory
    lets only ONE of them actually launch — the other 4 fail immediately with
    "BrowserType.launch_persistent_context: Target page, context or browser has
    been closed", contributing zero leads every single batch. A unique dir per
    call removes the contention entirely; the (unproven, and now moot) benefit of
    a shared profile — carrying DDG session/cookie state between different query
    variations — isn't worth silently discarding 80% of every batch's work for.
    Removed again after use so a long job's many queries don't leave hundreds of
    throwaway Chromium profiles on disk.
    """
    suffix = "" if proxy is None else "-" + proxy["label"].lower()
    profile_dir = os.path.join(job_dir, "ddg-profile" + suffix + "-" + uuid.uuid4().hex[:10])
    url = _DDG_URL + "?q=" + quote_plus(query)
    try:
        content = await _resilient_page_content(profile_dir, url, captcha_markers=_DDG_BLOCK_MARKERS, proxy=proxy)
        return _parse_ddg_html(content, _DDG_URL, max_results)
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


async def duckduckgo_search_paginated(
    query: str, max_results: int, pages_per_query: int, job_dir: str,
    on_step: Optional[AsyncStepCallable] = None,
) -> list[SearchResult]:
    """Drive DuckDuckGo's HTML results over up to `pages_per_query` pages via a
    real headless browser, submitting the results page's own "next page" form
    (inside a `<div class="nav-link">` wrapper — see the selector fix note at
    its query_selector call below) exactly like a human clicking Next —
    adapted from the original desktop engine (automation_server.py ~L978-994).
    That engine's own selector (`form.nav-link`) turns out to have the same
    bug this one did: confirmed live by dumping DDG's real page-1 DOM that the
    `nav-link` class sits on the wrapping `<div>`, never on the `<form>`
    itself, so neither engine's version of this selector could ever have
    matched anything — this was NOT a proven-working mechanism being ported,
    despite the original docstring's claim. DDG's next-page state lives in
    that form's hidden fields tied to the CURRENT browser session, not a stable/guessable
    URL parameter, so re-requesting a fresh URL (as duckduckgo_search_http and
    duckduckgo_search_playwright both do) can only ever get page 1 — this is
    why neither of those two ever advanced past it regardless of pagesPerQuery.
    Google's simpler `start=` offset (google_search_paginated) needs no
    equivalent because Google's pagination IS a stable URL parameter.

    Only used when the caller actually asked for more than one page — the
    existing single-page path (fast HTTP first, Playwright fallback on an
    anti-bot block) is untouched and stays the default for everyone who
    didn't raise pagesPerQuery above 1.

    Resilience is deliberately asymmetric: page 1 gets real retries (a fresh
    context + backoff on a captcha hit, matching _resilient_page_content's own
    approach) since a page-1 failure means zero results for this query. A
    failure advancing to page 2+ just stops pagination there and returns
    whatever was already collected — never fails the whole query over a
    later page not loading.
    """
    from playwright.async_api import async_playwright

    # Task 22/24: unique per call, not a fixed job-wide path — see the same
    # fix's rationale on duckduckgo_search_playwright above. This function is
    # the PRIMARY search path whenever pagesPerQuery > 1, which is exactly the
    # case Task 22's batching runs up to QUERY_BATCH_SIZE of concurrently, so
    # this collision was live in production, not theoretical: confirmed via a
    # 5-concurrent-call test sharing one profile_dir that 4 of 5 failed
    # immediately with "Target page, context or browser has been closed."
    # Removed again in the `finally` below so a long job's many queries don't
    # leave hundreds of throwaway Chromium profiles on disk.
    profile_dir = os.path.join(job_dir, "ddg-multipage-profile-" + uuid.uuid4().hex[:10])
    url = _DDG_URL + "?q=" + quote_plus(query)
    all_results: list[SearchResult] = []
    seen_urls: set[str] = set()

    async def _load_page_one(context):
        page = await context.new_page()
        await asyncio.sleep(random.uniform(1.5, 3.5))
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        content = await page.content()
        if _is_ddg_block_page(content):
            await page.close()
            raise _BlockedByCaptchaError("DuckDuckGo served an anti-bot challenge page")
        return page, content

    try:
        async with async_playwright() as p:
            context = await _launch_persistent_context(p, profile_dir)
            try:
                if on_step is not None:
                    await on_step(f"Visiting page 1 of {pages_per_query} of DuckDuckGo results")
                try:
                    page, content = await _load_page_one(context)
                except _BlockedByCaptchaError:
                    await asyncio.sleep(CAPTCHA_BACKOFF_SECONDS)
                    try:
                        await context.close()
                    except Exception:
                        pass
                    context = await _launch_persistent_context(p, profile_dir)
                    page, content = await _load_page_one(context)  # let this raise on a second failure

                for page_index in range(max(1, pages_per_query)):
                    if page_index > 0:
                        if on_step is not None:
                            await on_step(f"Visiting page {page_index + 1} of {pages_per_query} of DuckDuckGo results")
                        # Confirmed live by dumping DDG's real page-1 DOM: the "nav-link"
                        # class sits on the wrapping <div>, not the <form> itself
                        # (`<div class="nav-link"><form action="/html/" method="post">...`)
                        # — the previous `form.nav-link` selector could never match
                        # anything, so nav_form was always None and every query silently
                        # capped at page 1's ~10 results regardless of pagesPerQuery.
                        nav_form = await page.query_selector("div.nav-link form")
                        if nav_form is None:
                            break  # DDG has no further pages for this query
                        await asyncio.sleep(random.uniform(1.5, 3.5))
                        try:
                            # Confirmed live: racing page.content() against
                            # wait_for_load_state("domcontentloaded") right after
                            # form.submit() throws "Unable to retrieve content
                            # because the page is navigating and changing the
                            # content" — a real, reproducible race, not a rare
                            # flake — because the two aren't actually tied to the
                            # same navigation event. expect_navigation() waits on
                            # the navigation itself (the one form.submit() causes)
                            # before content() ever runs, which a live test
                            # confirmed reliably returns page 2's real, distinct
                            # results instead of racing into this exception on
                            # every single attempt.
                            async with page.expect_navigation(wait_until="domcontentloaded", timeout=30_000):
                                await nav_form.evaluate("form => form.submit()")
                            content = await page.content()
                        except Exception:
                            break  # couldn't advance — keep whatever was already collected
                        if _is_ddg_block_page(content):
                            break  # blocked mid-crawl — same reasoning, keep prior pages' results

                    new_count = 0
                    for r in _parse_ddg_html(content, _DDG_URL, max_results):
                        if r.url in seen_urls:
                            continue
                        seen_urls.add(r.url)
                        all_results.append(r)
                        new_count += 1
                    if len(all_results) >= max_results:
                        break
                    if new_count == 0 and page_index > 0:
                        break  # a real page with nothing new — treat as end of results
            finally:
                try:
                    await context.close()
                except Exception:
                    pass
        return all_results[:max_results]
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


async def google_search(
    query: str, max_results: int, job_dir: str, start: int = 0, proxy: Optional[dict] = None
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

    When `proxy` is a SpaceWorker exit node (see lib/exit-nodes.ts), the request
    is routed through that node's SOCKS5 and a SEPARATE per-node throwaway profile
    (`chrome-profile-us`/`chrome-profile-ca`) is used instead of the shared
    `chrome-profile` — so cookies/session state from the direct-IP requests never
    leak into what Google sees as a different visitor (and vice versa).
    """
    # Task 22/24: unique per call — same fix and rationale as
    # duckduckgo_search_playwright/duckduckgo_search_paginated above (Task 22's
    # batching runs this concurrently across a batch's queries when
    # engine=="google", and a shared profile_dir means Chromium's persistent-
    # context lock lets only one concurrent caller through). Safe with zero
    # continuity loss here specifically: unlike DDG, Google's own pagination
    # already uses a stable `start=` URL parameter rather than session state
    # (see this function's own docstring above), so each page/call never
    # needed to share a profile with any other call in the first place.
    # Removed again after use so a long job doesn't accumulate throwaway
    # Chromium profiles on disk.
    suffix = "" if proxy is None else "-" + proxy["label"].lower()
    profile_dir = os.path.join(job_dir, "chrome-profile" + suffix + "-" + uuid.uuid4().hex[:10])
    url = "https://www.google.com/search?q=" + quote_plus(query)
    if start > 0:
        url += "&start=" + str(start)
    try:
        content = await _resilient_page_content(
            profile_dir, url, captcha_markers=("unusual traffic", "captcha"), proxy=proxy,
        )
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)
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
    on_step: Optional[AsyncStepCallable] = None, proxy: Optional[dict] = None,
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
        page_results, has_next = await google_search(query, max_results, job_dir, start=start, proxy=proxy)
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
    """Confirmed directly against the standalone desktop extractor's own search
    modes (app/search/ddg_search.py, SEARCH_MODES): plain "filetype:pdf" is its
    "PDF Documents Only" mode, but its BEST-performing one for lead-gen is
    "pdf_emails" -- "filetype:pdf intext:@", which specifically biases toward
    PDFs that actually contain an "@" character (i.e., likely have real email
    addresses in them), not just any PDF about the topic. `intext:@` can only
    ever narrow toward MORE relevant results for a lead-extraction product --
    a PDF with zero "@" in it has no email to find anyway, so this never
    excludes anything actually useful. Live-confirmed 2026-09-11: this is very
    likely the concrete reason the standalone reliably lands on rich, bulk
    email-list documents (1500+ emails from its first PDF result) while plain
    "filetype:pdf" alone can surface any PDF, including ones with no emails.
    """
    q = query.strip()
    if "filetype:pdf" not in q.lower() and "filetype: pdf" not in q.lower():
        q = f"{q} filetype:pdf"
    if "intext:@" not in q.lower():
        q = f"{q} intext:@"
    if len(q) > MAX_DDG_QUERY_CHARS:
        q = q[:MAX_DDG_QUERY_CHARS].strip()
    return q


async def _duckduckgo_with_exit_nodes(pdf_query: str, max_results: int, job_dir: str) -> list[SearchResult]:
    """Last resort after a direct-IP DDG attempt (HTTP + Playwright) is confirmed
    blocked: cycle through SpaceWorker's own US/CA exit nodes until one gets
    through. Raises DDGBlockedError only once every configured node has failed.

    Catches Exception broadly, not just _BlockedByCaptchaError: a node can also
    fail for a reason that has nothing to do with anti-bot blocking (its relay is
    down, a SOCKS connection error, a navigation timeout) — _resilient_page_content
    can raise any of those via `raise last_err or RuntimeError(...)`. Treating only
    _BlockedByCaptchaError as "try the next node" meant one flaky node aborted the
    entire fallback chain instead of moving on to the next one (found in review,
    fixed before this ever ran against a real flaky node in production).
    """
    for node in _get_exit_nodes():
        try:
            return await duckduckgo_search_playwright(pdf_query, max_results, job_dir, proxy=node)
        except Exception:
            continue
    raise DDGBlockedError(
        "DuckDuckGo blocked this request on every available path (direct + all configured exit nodes)"
    )


async def search_phase(query: str, params: dict, job_dir: str,
                       on_step: Optional[AsyncStepCallable] = None) -> list[SearchResult]:
    engine = params.get("engine", "duckduckgo")
    # Confirmed against the real caller (app/dashboard/extract/page.tsx sends
    # `params: { engine, maxResults }`, camelCase) — the dispatcher's own
    # `POST /api/jobs` clamps this server-side to 10-200, so this worker-side
    # bound should match that ceiling, not sit below it. It used to clamp to
    # 50 regardless of what the user actually set (confirmed live: a job
    # created with maxResults=50000 silently got 50 per query here) — that
    # was the dominant reason jobs finished with far fewer leads than
    # requested, well before either the DDG-pagination or query-budget limits
    # below ever mattered.
    max_results = int(params.get("maxResults", 10))
    max_results = max(1, min(max_results, 50000))

    # Read once, used by both engines below — DDG pagination (added alongside
    # this fix) needs it exactly like Google's already did.
    raw_pages = params.get("pagesPerQuery", DEFAULT_PAGES_PER_QUERY)
    try:
        pages_per_query = max(1, min(int(raw_pages), 20))
    except (ValueError, TypeError):
        pages_per_query = DEFAULT_PAGES_PER_QUERY

    # Webmail platform SEARCH mode (filters/webmail_platforms.py) replaces the
    # PDF bias entirely rather than stacking with it — a webmail login page is
    # never a PDF, and `filetype:pdf` would just zero out these results.
    webmail_platforms = [p for p in (params.get("webmailPlatforms") or []) if isinstance(p, str)]

    def _biased_query(q: str) -> str:
        if webmail_platforms:
            return apply_webmail_bias_to_query(q, webmail_platforms)
        return _bias_query_toward_pdfs(q)

    if engine == "google":
        # Real crawler (Task 13): visit multiple result pages per query, bounded
        # independently the same way max_results is.
        pdf_query = _biased_query(query)
        try:
            return await google_search_paginated(pdf_query, max_results, pages_per_query, job_dir, on_step)
        except _BlockedByCaptchaError:
            # Google is durably blocking this IP for this query (already retried
            # with backoff inside _resilient_page_content). Before switching engines
            # entirely, retry Google itself through SpaceWorker's own exit nodes —
            # staying on the originally-requested engine is more aligned with intent
            # than silently switching engines the moment a block is hit.
            # Broad except, not just _BlockedByCaptchaError — a node can also fail
            # for a reason unrelated to blocking (relay down, SOCKS connection
            # error, navigation timeout); treating only a captcha hit as "try the
            # next node" meant one flaky node aborted the whole loop instead of
            # moving on (same fix as _duckduckgo_with_exit_nodes below).
            for node in _get_exit_nodes():
                try:
                    return await google_search_paginated(pdf_query, max_results, pages_per_query, job_dir, on_step, proxy=node)
                except Exception:
                    continue
            # Every exit node also blocked — existing behavior: fall back to DDG
            # rather than failing the query outright.
            if on_step is not None:
                await on_step(f"Google blocked — falling back to DuckDuckGo for: {query}")
            loop = asyncio.get_event_loop()
            try:
                return await loop.run_in_executor(_EXTRACTION_EXECUTOR, duckduckgo_search_http, pdf_query, max_results)
            except DDGBlockedError:
                try:
                    return await duckduckgo_search_playwright(pdf_query, max_results, job_dir)
                except _BlockedByCaptchaError:
                    return await _duckduckgo_with_exit_nodes(pdf_query, max_results, job_dir)

    pdf_query = _biased_query(query)

    # DDG's default path only ever fetched page 1 REGARDLESS of pagesPerQuery
    # (confirmed live: neither duckduckgo_search_http nor its Playwright
    # fallback took a page count at all) — one contributor, alongside the
    # max_results clamp above, to jobs collecting far fewer leads than a large
    # minResults target. Only take the slower multi-page browser path when the
    # caller actually asked for more than one page; the fast HTTP-first
    # single-page path below is unchanged for everyone who didn't.
    if pages_per_query > 1:
        try:
            return await duckduckgo_search_paginated(pdf_query, max_results, pages_per_query, job_dir, on_step)
        except _BlockedByCaptchaError:
            pass  # fall through to the plain single-page path below

    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(_EXTRACTION_EXECUTOR, duckduckgo_search_http, pdf_query, max_results)
    except DDGBlockedError:
        try:
            # Confirmed-real fallback (see duckduckgo_search_http docstring) — the
            # lightweight path is blocked for this request, so pay the Chromium cost
            # this one time rather than failing the whole job.
            return await duckduckgo_search_playwright(pdf_query, max_results, job_dir)
        except _BlockedByCaptchaError:
            # The direct-IP Playwright path is durably blocked too — last resort:
            # cycle through SpaceWorker's own exit nodes (route through a cleaner
            # exit IP rather than giving up on the query outright).
            return await _duckduckgo_with_exit_nodes(pdf_query, max_results, job_dir)


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


def extract_lead_page(result: SearchResult, on_step: Optional[SyncStepCallable] = None) -> list[dict]:
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


def _fetch_pdf_text(url: str) -> str:
    """Download a PDF and return its extracted text, or \"\" on any failure
    (unreachable, corrupt, encrypted, scanned-image-only, or pypdf unavailable).
    Shared by extract_lead_pdf (a result that IS a PDF) and extract_lead_page's
    new embedded-PDF-link following (a result whose PAGE links to a PDF).
    """
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        reader = PdfReader(BytesIO(resp.content))
        if reader.is_encrypted:
            return ""
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
        return "\n".join(page_texts)
    except Exception:
        return ""


def _find_embedded_pdf_links(
    soup: "BeautifulSoup",
    base_url: str,
    limit: int = _MAX_EMBEDDED_PDFS_PER_PAGE,
) -> list[str]:
    """Scan a parsed page for <a href> links pointing at a PDF (case-insensitive,
    ignoring a trailing query string), resolve each to an absolute URL via the
    existing _absolute_url(), dedupe, and cap at `limit` — a page can link to
    many documents; bound the extra cost rather than following all of them.
    """
    found: list[str] = []
    seen: set[str] = set()
    for a in soup.select("a[href]"):
        href = a.get("href") or ""
        path = href.lower().split("?", 1)[0].rstrip("/")
        if not path.endswith(".pdf"):
            continue
        abs_url = _absolute_url(href, base_url)
        if abs_url in seen:
            continue
        seen.add(abs_url)
        found.append(abs_url)
        if len(found) >= limit:
            break
    return found


def extract_lead_pdf(result: SearchResult) -> list[dict]:
    """Download a PDF result, extract its text, and produce 0..N leads.

    Reuses the exact same _build_leads/_extract_* pipeline extract_lead_page()
    uses on HTML text — no parallel extraction implementation for PDF text. A PDF
    that can't be fetched or parsed (corrupt/encrypted/scanned-image-only, or
    pypdf unavailable) yields zero leads rather than crashing the job. The actual
    PDF-to-text work lives in the shared _fetch_pdf_text() helper (Task 17), so
    this is a thin wrapper over that + the shared extraction sequence.
    """
    pdf_text = _fetch_pdf_text(result.url)
    if not pdf_text.strip():
        return []

    emails = _extract_emails(pdf_text)
    phones = _extract_phones(pdf_text)
    contact_names = _extract_contact_names(pdf_text)
    if emails and not contact_names:
        contact_names = [n for n in (_extract_names_from_email(e) for e in emails) if n]
    return _build_leads(result, emails, phones, contact_names)


def extract_webmail_lead(
    result: SearchResult,
    platform_codes: list[str],
    on_step: Optional[SyncStepCallable] = None,
) -> list[dict]:
    """SEARCH-mode webmail extraction (see filters/webmail_platforms.py):
    result.url is itself a webmail LOGIN page found via an intitle: dork, not
    a business directory page — it has no name/email/phone to extract. Fetch
    it once to CONFIRM the platform (a title-based dork hit alone isn't proof;
    some unrelated indexed page could coincidentally share the title text),
    then produce exactly one lead with the DOMAIN as the actionable result and
    email/phone/contactName left null — there is genuinely nothing else to
    extract from a login form. This deliberately breaks from _build_leads'
    "zero contact info = zero leads" rule (Task 13): that rule exists to stop
    guessing from an unrelated page's content, but here the domain itself
    (not a guess) IS the lead this search mode exists to find.
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
        return []

    platform = detect_webmail_platform(html, platform_codes)
    if not platform:
        # Title dork hit but no confirmed fingerprint — a false positive
        # (unrelated page, or the platform changed its markup). Drop it
        # rather than reporting an unverified guess.
        return []

    if on_step is not None:
        on_step(f"Confirmed {platform} at {result.url}")

    netloc = urlparse(result.url).netloc
    root_domain = netloc.removeprefix("www.")
    business_name = _extract_business_name(result.title, result.url, result.snippet) or root_domain

    return [{
        "email": None,
        "phone": None,
        "contactName": None,
        "businessName": business_name,
        "website": f"https://{root_domain}" if root_domain else result.url,
        "sourceUrl": result.url,
        "snippet": f"Detected: {platform} webmail",
    }]


def probe_lead_for_webmail(lead: dict, platform_codes: list[str] | None) -> dict | None:
    """VERIFY/PROBE mode (see filters/webmail_platforms.py): given a lead
    already found the normal way (has an email, therefore a domain), actively
    check a short, bounded list of candidate URLs on that domain for a
    self-hosted webmail platform. Returns the lead (annotated in `snippet`)
    if confirmed, else None. Short-circuits on the first confirmed match —
    real extra network requests per lead, so this stays as cheap as possible.
    """
    email = lead.get("email") or ""
    if "@" not in email:
        return None
    domain = email.rsplit("@", 1)[-1].strip().lower()
    if not domain:
        return None

    for url in candidate_webmail_urls(domain):
        try:
            resp = requests.get(
                url,
                headers={"User-Agent": BROWSER_USER_AGENT},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            if resp.status_code >= 400:
                continue
            platform = detect_webmail_platform(resp.text, platform_codes)
        except Exception:
            continue
        if platform:
            annotated = dict(lead)
            existing_snippet = annotated.get("snippet") or ""
            note = f"Detected: {platform} webmail"
            annotated["snippet"] = f"{existing_snippet} — {note}" if existing_snippet else note
            return annotated
    return None


def _extract_result(result: SearchResult,
                    on_step: Optional[SyncStepCallable] = None,
                    webmail_platforms: Optional[list[str]] = None) -> list[dict]:
    """Dispatch one search result to the right extractor (PDF vs real page).

    Shared by _search_and_extract() for every result on every page — keeps the
    PDF/HTML branching in exactly one place. Never guesses from the search snippet:
    a result with no real extractable content (HTML or PDF) simply yields no leads.

    Task 14: `on_step` is a plain *sync* reporter (not the async on_step passed
    around elsewhere) because this function runs in a run_in_executor thread and
    therefore can't await; _search_and_extract() hands it a thread-safe adapter.
    """
    try:
        if webmail_platforms:
            # SEARCH-mode webmail job: every result is a login page found via
            # an intitle: dork, never a PDF/directory page — see
            # extract_webmail_lead's docstring for why this skips the normal
            # PDF/HTML branching entirely.
            return extract_webmail_lead(result, webmail_platforms, on_step)
        if _is_pdf_result(result):
            if on_step is not None:
                on_step(f"Reading a PDF at {result.url}")
            return extract_lead_pdf(result)
        if on_step is not None:
            on_step(f"Extracting a page at {result.url}")
        return extract_lead_page(result, on_step)
    except Exception:
        return []


# Minimum-results auto-expansion (Task: "keep adding related words until we
# hit the minimum"). Deterministic, no external API/LLM dependency — appends
# qualifier suffixes to each ORIGINAL base term to generate new search
# variants, one suffix per round (so the outer loop's between-round "have we
# hit the minimum yet" check actually has a chance to stop early instead of
# every suffix being dumped into a single first round). Bounded on both axes
# (rounds = len(_EXPANSION_SUFFIXES), and total query count) so a
# never-satisfiable minimum (e.g. minResults=10000) can't loop indefinitely or
# hammer the search engine.
#
# Ported directly from the standalone Lead Extractor's real, proven live
# automation loop (app/server/automation_server.py's DDG_QUERY_VARIATIONS —
# NOT the separate, unused-by-that-flow app/search/ddg_search.py SEARCH_MODES
# module). Confirmed by reading the standalone's actual extraction path
# (extract_from_pdf reads every page of a PDF via pdfplumber, same as this
# file's own unbounded _fetch_pdf_text, and uses the identical email regex/
# filter logic already in this file's extractors/email_extractor.py) that the
# real gap producing "1500 emails from one PDF" vs. single-digit leads here
# was never extraction depth — it was query targeting. The suffixes below
# (previously generic single-business qualifiers like " near me"/" LLC") are
# replaced with the standalone's real list, which deliberately hunts for
# BULK multi-email documents (rosters, membership/staff directories, board
# lists) rather than one business's single contact page. Every one of these
# still gets `filetype:pdf`+`intext:@`-biased by _bias_query_toward_pdfs()
# below, exactly like the standalone force-appends `filetype:pdf` to every
# query in its own loop.
_EXPANSION_SUFFIXES = [
    " directory", " roster", " members", " membership",
    " board of directors", " committee", " officers", " chapter",
    " email directory", " staff directory", " contact list",
    " member directory", " phone directory", " directory contact",
    " annual report", " meeting minutes", " registration form",
    " volunteers", " club", " association", " foundation",
    " nonprofit", " public records", " state filing", " tax exempt",
    " organization", " leadership", " team", " contacts page",
]

# Task 23: once every single-suffix round above is exhausted, keep generating
# genuinely new query text by combining PAIRS of suffixes instead of stopping.
# Precomputed once (28 suffixes -> C(28,2) = 378 pairs) rather than recomputed
# per call — cheap either way at this size, but this makes the deterministic
# ordering explicit and reusable. This is what lets a long, high-minResults
# job keep inventing new variations for its FULL allotted duration instead of
# running out of ideas early — see _round_queries and the real bug this fixes,
# documented on MAX_TOTAL_QUERIES_SAFETY_CEILING below.
_SUFFIX_PAIR_INDICES = list(itertools.combinations(range(len(_EXPANSION_SUFFIXES)), 2))

# NOT a design target — a pure safety valve against a pathological input
# (e.g. hundreds of base terms) blowing up memory/CPU. The PREVIOUS constant
# here (MAX_TOTAL_QUERIES = 300) was a real, confirmed bug: once Task 22's
# batching made per-query processing fast, a real minResults=5000 job with 20
# base terms exhausted that entire 300-query budget in under 10 minutes out of
# a 30-minute allowance and reported "done" — reading like success but
# actually meaning "ran out of pre-generated query text with 20+ minutes and
# the target still nowhere close." The wall-clock deadline and min_results
# check (both still enforced every batch, see the main loop below) are the
# REAL stopping conditions now; this ceiling should essentially never be hit
# by a normal job (20 base terms alone yield 20 + 20*28 + 20*378 ≈ 8,160
# distinct combinations before this ceiling would even matter).
MAX_TOTAL_QUERIES_SAFETY_CEILING = 20000


def _round_queries(base_terms: list[str], round_index: int) -> list[str]:
    """Generate the raw candidate query strings for one expansion round, in an
    order determined ONLY by `round_index` — this determinism is what lets a
    resumed job regenerate the exact same continuing sequence from a bare
    `nextQueryIndex` integer, with no need to separately persist which
    suffixes/pairs were already tried.

    Round 0: the original base terms, unmodified.
    Rounds 1..len(_EXPANSION_SUFFIXES): base_terms + ONE single suffix.
    Rounds after that: base_terms + a PAIR of two different suffixes, cycling
    through _SUFFIX_PAIR_INDICES in order.
    Returns [] once round_index runs past every pair combination too — the
    caller (_grow_queries) treats that as truly nothing left to generate.
    """
    n = len(_EXPANSION_SUFFIXES)
    if round_index == 0:
        return list(base_terms)
    if round_index <= n:
        suffix = _EXPANSION_SUFFIXES[round_index - 1]
        return [f"{t}{suffix}" for t in base_terms]
    pair_idx = round_index - n - 1
    if pair_idx >= len(_SUFFIX_PAIR_INDICES):
        return []
    i, j = _SUFFIX_PAIR_INDICES[pair_idx]
    combined_suffix = f"{_EXPANSION_SUFFIXES[i]}{_EXPANSION_SUFFIXES[j]}"
    return [f"{t}{combined_suffix}" for t in base_terms]


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

    # Webmail platform targeting (see filters/webmail_platforms.py) — two
    # independent, mutually-exclusive-per-lead modes:
    #   SEARCH (webmail_platforms non-empty): every result IS a webmail login
    #     page (search_phase biased the query itself); _extract_result routes
    #     to extract_webmail_lead instead of the normal PDF/HTML branch.
    #   VERIFY (verify_webmail): leads are found the NORMAL way, then each one
    #     is probed on its own domain and dropped unless a platform confirms —
    #     real extra network requests per lead, so it's opt-in and separate.
    webmail_platforms: list[str] = [
        p for p in (params.get("webmailPlatforms") or []) if isinstance(p, str)
    ]
    verify_webmail = params.get("verifyWebmail") is True and not webmail_platforms

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

        # Hard per-result timeout: asyncio.gather() (below) has NO overall
        # timeout of its own -- if even ONE result's extraction hangs
        # indefinitely (confirmed live 2026-09-11: a job stalled at 13 leads
        # for 10+ minutes with zero progress, last known to be on a slow
        # government site's page), the ENTIRE batch never completes, even
        # though every other result may have finished in seconds. requests'
        # own timeout=REQUEST_TIMEOUT_SECONDS doesn't always bound this (DNS
        # resolution in particular isn't reliably covered by it on every
        # platform), so this wraps the WHOLE per-result call in a generous but
        # finite asyncio-level cap. Note the real limitation: this stops the
        # JOB from waiting on a stuck result, but cannot forcibly kill the
        # underlying executor thread if it's truly hung (Python's thread pool
        # has no cancellation mechanism) -- that one thread may stay stuck in
        # the background. Accepted tradeoff: an occasional leaked thread is far
        # better than the whole job (and the lane it's holding, blocking every
        # other user's queued job too) freezing indefinitely.
        try:
            leads = await asyncio.wait_for(
                loop.run_in_executor(
                    _EXTRACTION_EXECUTOR, _extract_result, result, report_step_sync, webmail_platforms or None
                ),
                timeout=PER_RESULT_HARD_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            if on_step is not None:
                await on_step(f"Skipped (timed out after {PER_RESULT_HARD_TIMEOUT_SECONDS}s): {result.url}")
            return []
        kept: list[dict] = []
        for lead in leads:
            # Filter at the point of emission so on_progress stream and final list
            # stay in sync — leads that don't match are never stored or returned.
            # Skipped entirely for SEARCH-mode webmail leads: they never have an
            # email (there's nothing to match a domain allowlist against), and
            # dropping them here would silently discard every result.
            if not webmail_platforms and domain_rules is not None and not domain_rules.is_empty():
                if not email_matches_rules(lead.get("email") or "", domain_rules):
                    continue
            if verify_webmail:
                # Real extra network request — off the event loop, same
                # per-result executor as everything else here.
                probed = await loop.run_in_executor(_EXTRACTION_EXECUTOR, probe_lead_for_webmail, lead, None)
                if probed is None:
                    continue
                lead = probed
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
    `_grow_queries` (below) LAZILY extends the query list on demand via
    `_round_queries` — single-suffix rounds, then paired-suffix rounds once
    those run out — instead of precomputing a small, fixed-size budget up
    front. The loop stops as soon as the minimum is met, the deadline is hit,
    or (extremely rarely — thousands of combinations deep) generation
    genuinely runs out; leads accumulate (deduped by URL via the shared
    seen_urls set); on_progress fires for every lead as found. This replaced
    an old fixed 300-query cap that was a real, confirmed bug (Task 23): once
    Task 22's batching made per-query processing fast, jobs exhausted that
    cap in a fraction of their allotted duration and reported "done" with
    the target nowhere close and most of the time budget still unused.

    Pause / max-duration (resumable jobs): the loop processes queries in CONCURRENT
    batches (QUERY_BATCH_SIZE at a time — Task 22) and checks `should_stop()` AND
    the wall-clock deadline ONLY at batch boundaries (never mid-batch). This
    deliberately trades per-query pause precision for meaningfully faster overall
    throughput: up to QUERY_BATCH_SIZE queries may complete before the next check.
    When either fires, run_automation returns normally (not raise/cancel) with
    status "paused" plus a resume_state payload so worker/api.py can persist all
    leads found so far and a later resume continues from the start of the next
    unprocessed batch instead of restarting from query #1. `nextQueryIndex` is the
    start of that batch (qi advances by len(batch) at a time); a resumed job may
    rarely re-run one query caught mid-flight in an interrupted batch — safe because
    the persisted seen_urls set prevents duplicate leads even if a URL is fetched
    twice.
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

    # Task 23: ordered_queries now grows LAZILY on demand (see _grow_queries)
    # instead of being fully precomputed up front — the list starts empty and
    # is extended just-in-time, round by round via _round_queries, only as far
    # as the main loop (or resume) actually needs at any given moment.
    ordered_queries: list[str] = []
    _used_queries: set[str] = set()
    _next_round = 0
    _expansion_enabled = min_results is not None and min_results > 0

    def _grow_queries(target_len: int) -> None:
        """Extend `ordered_queries` (deduped) until it has at least
        `target_len` entries, generation genuinely runs out, or the safety
        ceiling is hit. When expansion is disabled (no minResults set), only
        round 0 — the bare base terms — is ever generated, matching the old
        "expansion suffixes only appear when min_results is set" gating —
        and, since this is called repeatedly as the main loop advances,
        that round-0-only limit must hold on EVERY call, not just the
        first: `_next_round` is nonlocal/persistent, so checking "is this
        round 0" only within a single call's loop (as an earlier version of
        this function did) let rounds 1, 2, 3... keep being generated on
        every SUBSEQUENT call once `_next_round` had already advanced past
        0 — a real bug caught by this task's own test suite before it
        shipped. Branching on `_expansion_enabled` up front avoids that
        entirely: the disabled path only ever touches round 0, once, no
        matter how many times or with what target_len it's called."""
        nonlocal _next_round
        if not _expansion_enabled:
            if _next_round == 0:
                for c in _round_queries(base_terms, 0):
                    if c not in _used_queries:
                        _used_queries.add(c)
                        ordered_queries.append(c)
                _next_round = 1
            return
        target_len = min(target_len, MAX_TOTAL_QUERIES_SAFETY_CEILING)
        while len(ordered_queries) < target_len:
            candidates = _round_queries(base_terms, _next_round)
            _next_round += 1
            if not candidates:
                break  # every combination this generator can produce is exhausted
            for c in candidates:
                if c not in _used_queries:
                    _used_queries.add(c)
                    ordered_queries.append(c)
            if len(ordered_queries) >= MAX_TOTAL_QUERIES_SAFETY_CEILING:
                break

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
            _grow_queries(idx)  # regenerate the same deterministic sequence up to idx
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
    stopped_at = start_index  # only meaningful if a pause path below overwrites it
    # A single failed query (one bad page, a transient blip) is isolated below —
    # correct to keep going. But if the search engine is genuinely down for a
    # stretch, an entire batch of queries fails just as fast, and the loop would
    # otherwise run to completion with almost nothing found and report "done" —
    # a status that can never be resumed. CONSECUTIVE_FAILURE_PAUSE_THRESHOLD
    # consecutive ENTIRELY-failed batches (every query in the batch errored,
    # not just one) is treated as "looks like an outage" instead: pause AT that
    # batch's start index (not counted as processed, so resume retries it) so a
    # later dispatcher tick can pick this job back up once the engine is
    # reachable again, rather than silently finishing short.
    CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 5
    consecutive_failures = 0
    # Distinguishes an outage-triggered pause (below) from a manual pause or the
    # duration cap — only an outage pause is safe to auto-resume without a human
    # looking at it (the other two are the user's own deliberate stop).
    pause_reason: Optional[str] = None

    # Task 22: process query variations in CONCURRENT BATCHES, not one at a
    # time. The old loop searched + fully extracted each query variation strictly
    # sequentially, so with a large minResults budget the wall-clock deadline
    # ran out after only a handful of queries no matter how many good
    # variations were left to try — the confirmed throughput bottleneck. Reuse
    # the exact concurrency pattern
    # _search_and_extract already uses internally (a per-result asyncio.gather
    # with return_exceptions): run QUERY_BATCH_SIZE query variations side by side
    # and merge their leads. seen_urls stays a single shared set (already passed
    # into every call and dedup-ed inside), so two concurrent queries that surface
    # the same URL still only process it once between them.
    QUERY_BATCH_SIZE = 5  # fixed constant for now — tunable by a future task

    async def _run_one_query(term: str) -> list[dict] | Exception:
        # Isolate each query in the batch so one blocked/errored query (a single
        # bad search) contributes zero leads instead of aborting the whole batch
        # — same isolation the old multi-query gather's return_exceptions gave.
        try:
            return await _search_and_extract(
                [term], params, job_dir, on_progress, seen_urls, domain_rules, on_step
            )
        except Exception as e:  # noqa: BLE001 — deliberately captured, converted below
            return e

    qi = start_index
    while True:
        # Stop checks — now observed at BATCH granularity, the ONLY place
        # pause/deadline are checked. Up to QUERY_BATCH_SIZE queries may complete
        # before the next check; a deliberate trade of pause-timing precision for
        # meaningfully faster overall progress.
        if min_results is not None and min_results > 0 and prior_found + len(all_leads) >= min_results:
            break  # minimum reached — normal completion
        if should_stop is not None and await should_stop():
            paused = True
            pause_reason = "manual"
            stopped_at = qi
            break
        if time.monotonic() >= deadline:
            paused = True
            pause_reason = "duration_cap"
            stopped_at = qi
            break

        # Task 23: grow the query list on demand rather than looping over a
        # precomputed one — this is what lets the job keep inventing new
        # query text for as long as the deadline/target above allow, instead
        # of stopping the moment a small fixed list runs out.
        _grow_queries(qi + QUERY_BATCH_SIZE)
        batch = ordered_queries[qi : qi + QUERY_BATCH_SIZE]
        if not batch:
            break  # genuinely nothing left to generate — normal completion, not a pause

        batch_results = await asyncio.gather(*(_run_one_query(t) for t in batch))

        batch_failures = 0
        for r in batch_results:
            if isinstance(r, Exception):
                batch_failures += 1
            else:
                all_leads.extend(r)

        if batch_failures == len(batch):
            # Every query in this batch failed — same "looks like an outage"
            # reasoning as the old consecutive-failure check, just at batch
            # granularity now. A whole batch failing outright is the signal; a
            # single query failing within an otherwise-successful batch is NOT
            # specially isolated/counted anymore — it just contributes no leads.
            # Pause AT the start of this batch (do not advance past it) so resume
            # retries all of it, rather than treating a full-batch wipeout as
            # isolated per-query noise.
            consecutive_failures += 1
            if consecutive_failures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD:
                paused = True
                pause_reason = "outage"
                stopped_at = qi
                if on_step is not None:
                    await on_step(
                        f"{consecutive_failures} batch(es) in a row failed entirely — pausing, will retry automatically"
                    )
                break
        else:
            consecutive_failures = 0

        qi += len(batch)

    if paused:
        return AutomationResult(
            leads=all_leads,
            status="paused",
            resume_state={
                "processedQueries": ordered_queries[:stopped_at],
                "nextQueryIndex": stopped_at,
                "seenUrls": sorted(seen_urls),
                "foundLeads": prior_found + len(all_leads),
                "pauseReason": pause_reason,
            },
        )
    return AutomationResult(leads=all_leads, status="done", resume_state=None)
