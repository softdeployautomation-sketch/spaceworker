#!/usr/bin/env python3
"""SpaceWorker extraction worker — core extraction logic (Task 2).

Pure Python; no FastAPI imports here. This module is the adapted version of the
original lead-extractor automation_server.py:
- The original broadcast() WebSocket callback is replaced by an injected
  on_progress async callback that receives one lead dict at a time.
- The DuckDuckGo path uses plain requests + BeautifulSoup (verified by
  worker/test_ddg.py — 5+ results parse cleanly with .result selectors),
  so no Chromium/Playwright launch is needed for the default no-CAPTCHA path.
- Google still uses Playwright (it genuinely needs a real browser for CAPTCHA
  handling). The Chromium profile is a fresh throwaway profile inside the job's
  own directory — never a shared or long-lived profile.

Entry point:
    run_automation(query, params, job_dir, on_progress) -> list[dict]

The Google path requires Playwright browsers installed:
    playwright install chromium
"""

from __future__ import annotations

import asyncio
import os
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


def duckduckgo_search(query: str, max_results: int) -> list[SearchResult]:
    """Plain-HTTP DuckDuckGo search. Blocking — run via run_in_executor."""
    url = "https://html.duckduckgo.com/html/"
    resp = requests.get(
        url,
        params={"q": query},
        headers={"User-Agent": BROWSER_USER_AGENT},
        timeout=20,
    )
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "lxml")

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
        href = _absolute_url(raw_href, url)
        real_url = _decode_ddg_url(href)
        snippet = s.get_text(" ", strip=True) if s else ""
        results.append(SearchResult(title=title, url=real_url, snippet=snippet))
        if len(results) >= max_results:
            break
    return results[:max_results]


async def google_search(query: str, max_results: int, job_dir: str) -> list[SearchResult]:
    """Playwright Google search with a per-job throwaway profile."""
    from playwright.async_api import async_playwright

    chrome_profile = os.path.join(job_dir, "chrome-profile")

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            chrome_profile,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            page = await context.new_page()
            await page.goto(
                "https://www.google.com/search?q=" + quote_plus(query),
                wait_until="domcontentloaded",
                timeout=30_000,
            )
            content = await page.content()
            lowered = content.lower()
            if "unusual traffic" in lowered or "captcha" in lowered:
                raise RuntimeError("Google CAPTCHA detected")

            results: list[SearchResult] = []
            for el in await page.query_selector_all("div.g, div[data-hveid]"):
                h3 = await el.query_selector("a h3")
                if not h3:
                    continue
                title = (await h3.inner_text()).strip()
                a = await el.query_selector("a")
                href = await a.get_attribute("href") if a else None
                url = _absolute_url(href or "", "https://www.google.com/")
                snippet_el = await el.query_selector("div.VwiC3b, div[data-sncf]")
                snippet = (await snippet_el.inner_text()).strip() if snippet_el else ""
                results.append(SearchResult(title=title, url=url, snippet=snippet))
                if len(results) >= max_results:
                    break
            return results[:max_results]
        finally:
            await context.close()


async def search_phase(query: str, params: dict, job_dir: str) -> list[SearchResult]:
    engine = params.get("engine", "duckduckgo")
    max_results = int(params.get("max_results", 10))
    max_results = max(1, min(max_results, 50))

    if engine == "google":
        return await google_search(query, max_results, job_dir)
    return await asyncio.get_event_loop().run_in_executor(
        None, duckduckgo_search, query, max_results,
    )


def extract_lead_page(result: SearchResult) -> Optional[dict]:
    """Fetch one result page and extract email/phone/name metadata."""
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
        if not emails and not phones:
            return None
        return {
            "email": emails[:3],
            "phone": phones[:3],
            "businessName": _extract_business_name(result.title, result.url, result.snippet),
            "contactName": None,
            "website": result.url,
            "sourceUrl": result.url,
            "snippet": result.snippet,
        }

    soup = BeautifulSoup(html, "lxml")
    page_text = soup.get_text(" ", strip=True)

    # Use dedicated extractors — they handle mailto: links, junk-domain
    # filtering, and false-extension removal so automation.py has no
    # parallel implementations that could silently drift.
    emails = _extract_emails(page_text, html)
    phones = _extract_phones(page_text, html)

    if not emails and not phones:
        return None

    # Best-effort contact name: try structured patterns in page text first,
    # then fall back to guessing from the email local-part.
    contact_names = _extract_contact_names(page_text)
    contact_name: Optional[str] = (
        contact_names[0] if contact_names
        else (_extract_names_from_email(emails[0]) if emails else None) or None
    )

    return {
        "email": emails[:3],
        "phone": phones[:3],
        "businessName": _extract_business_name(result.title, result.url, result.snippet),
        "contactName": contact_name,
        "website": result.url,
        "sourceUrl": result.url,
        "snippet": result.snippet,
    }


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

    async def process_one(result: SearchResult) -> Optional[dict]:
        lead = await loop.run_in_executor(None, extract_lead_page, result)
        if lead is None:
            return None
        # Filter at the point of emission so on_progress stream and final list
        # stay in sync — leads that don't match are never stored or returned.
        if domain_rules is not None and not domain_rules.is_empty():
            lead_emails: list[str] = lead.get("email") or []
            if not any(email_matches_rules(e, domain_rules) for e in lead_emails):
                return None
        await on_progress(lead)
        return lead

    # return_exceptions=True so one failed page (malformed markup, name-extractor
    # error, etc.) doesn't abort the entire batch — other results still land.
    leads_raw = await asyncio.gather(
        *[process_one(r) for r in unique_results],
        return_exceptions=True,
    )
    return [l for l in leads_raw if isinstance(l, dict)]
