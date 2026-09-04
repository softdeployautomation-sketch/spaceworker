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
import sys
from dataclasses import dataclass
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

AsyncCallable = Callable[[dict], Awaitable[None]]


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


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


async def _launch_persistent_context(playwright, profile_dir: str):
    """Launch a persistent Chromium context, falling back to system Chrome if the
    bundled Chromium binary is missing (ENOENT/spawn failure) — ported from the
    original engine's browser-launch fallback (automation_server.py ~L642-662)."""
    launch_kwargs = dict(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        return await playwright.chromium.launch_persistent_context(profile_dir, **launch_kwargs)
    except Exception as e:
        err = str(e).lower()
        if "enoent" in err or "spawn" in err or "failed to launch" in err:
            return await playwright.chromium.launch_persistent_context(
                profile_dir, channel="chrome", **launch_kwargs
            )
        raise


async def _resilient_page_content(profile_dir: str, url: str, captcha_markers: tuple[str, ...]) -> str:
    """Navigate to `url` in a fresh per-job persistent Chromium context and return
    page.content(). Retries navigation up to NAV_MAX_ATTEMPTS times (transient network
    hiccups), and — if every attempt in the first context fails — recreates the
    context once and retries again, adapting the original engine's browser-launch
    fallback + "reload between batches" resilience pattern (automation_server.py
    ~L642-662, ~L863-925) to this worker's single-query-per-job shape. Raises if any
    `captcha_markers` substring (case-insensitive) is found in the page content —
    no human is present on this headless server worker to solve a CAPTCHA (unlike the
    original desktop engine's 60s wait-for-manual-solve loop), so fail fast instead.
    """
    from playwright.async_api import async_playwright

    async def _one_attempt(context) -> str:
        page = await context.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            content = await page.content()
            lowered = content.lower()
            for marker in captcha_markers:
                if marker.lower() in lowered:
                    raise RuntimeError(f"blocked: '{marker}' marker present")
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
                    await asyncio.sleep(NAV_RETRY_DELAY_SECONDS)
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


async def google_search(query: str, max_results: int, job_dir: str) -> list[SearchResult]:
    """Playwright Google search with a per-job throwaway profile."""
    profile_dir = os.path.join(job_dir, "chrome-profile")
    url = "https://www.google.com/search?q=" + quote_plus(query)
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
    return results[:max_results]


async def search_phase(query: str, params: dict, job_dir: str) -> list[SearchResult]:
    engine = params.get("engine", "duckduckgo")
    # Confirmed against the real caller (app/dashboard/extract/page.tsx sends
    # `params: { engine, maxResults }`, camelCase) — the dispatcher's own
    # `POST /api/jobs` clamps this server-side to 10-200 before it ever reaches
    # here, so this worker-side max(1, min(..., 50)) is a second, independent
    # bound, not the source of truth for the real limit.
    max_results = int(params.get("maxResults", 10))
    max_results = max(1, min(max_results, 50))

    if engine == "google":
        return await google_search(query, max_results, job_dir)

    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, duckduckgo_search_http, query, max_results)
    except DDGBlockedError:
        # Confirmed-real fallback (see duckduckgo_search_http docstring) — the
        # lightweight path is blocked for this request, so pay the Chromium cost
        # this one time rather than failing the whole job.
        return await duckduckgo_search_playwright(query, max_results, job_dir)


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
    """Fetch one result page and extract email/phone/name metadata as 0..N leads."""
    try:
        resp = requests.get(
            result.url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        html = resp.text
    except Exception:
        # Page unreachable — fall back to snippet
        emails = _extract_emails(result.snippet)
        phones = _extract_phones(result.snippet)
        contact_names = _extract_contact_names(result.snippet)
        if emails and not contact_names:
            # Best-effort: derive a name from each email's local-part, same fallback
            # the original engine applies (automation_server.py ~L394-399).
            contact_names = [n for n in (_extract_names_from_email(e) for e in emails) if n]
        return _build_leads(result, emails, phones, contact_names)

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


async def run_automation(
    query: str,
    params: dict,
    job_dir: str,
    on_progress: AsyncCallable,
) -> list[dict]:
    """Run a full extraction job: search then concurrent per-page extraction."""
    loop = asyncio.get_event_loop()
    results = await search_phase(query, params, job_dir)

    seen_urls: set[str] = set()
    unique_results: list[SearchResult] = []
    for r in results:
        if r.url not in seen_urls:
            seen_urls.add(r.url)
            unique_results.append(r)

    # Parse email domain allowlist once so all concurrent workers share it.
    raw_domain_rules = params.get("emailDomains") or params.get("email_domains")
    domain_rules = parse_email_domain_allowlist(str(raw_domain_rules)) if raw_domain_rules else None

    async def process_one(result: SearchResult) -> list[dict]:
        leads = await loop.run_in_executor(None, extract_lead_page, result)
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
