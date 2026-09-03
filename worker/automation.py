#!/usr/bin/env python3
"""SpaceWorker extraction worker — core extraction logic (Task 2).

Pure Python; no FastAPI imports here. This module is the adapted version of the
original lead-extractor `automation_server.py`:
- The original `broadcast()` WebSocket callback is replaced by an injected
  `on_progress` async callback that receives one lead dict at a time.

- The DuckDuckGo path uses plain `requests` + BeautifulSoup (verified by
  `worker/test_ddg.py` — 5+ results parse cleanly with `.result` selectors),
  so no Chromium/Playwright launch is needed for the default no-CAPTCHA path.

- Google still uses Playwright (it genuinely needs a real browser for CAPTCHA
  handling). The Chromium profile is a fresh throwaway profile inside the job's
  own directory — never a shared or long-lived profile (per-user persistent
  profiles are explicitly Phase 1.5, a separate later task).

Entry point:
    run_automation(query, params, job_dir, on_progress) -> list[dict]

The Google path requires Playwright browsers installed:
    playwright install chromium
"""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional
from urllib.parse import parse_qs, unquote, urljoin

import requests
from bs4 import BeautifulSoup

# A real browser User-Agent — search engines and most sites serve (slightly)
# different markup to non-browser clients, so every fetch pretends to be
# a normal desktop Chrome.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

REQUEST_TIMEOUT_SECONDS = 10

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(
    r"(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4})"
)

# Asset/file extensions that can never be a real email address.
ASSET_EXTENSION_RE = re.compile(
    r"\.(?:png|jpe?g|gif|webp|svg|bmp|ico|css|js|json|xml|pdf|zip|tar|gz|mp4|mp3|avi|mov|woff2?|ttf|eot)$",
    re.IGNORECASE,
)

AsyncCallable = Callable[[dict], Awaitable[None]]


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


def _decode_ddg_url(href: str) -> str:
    """DDG result `<a>` hrefs are redirect links (`//duckduckgo.com/l/?uddg=<encoded>`).
    Decode the real destination URL; fall back to the raw href if unparseable.
    """

    if "uddg=" in href:
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
    """Plain-HTTP DuckDuckGo search (verified working by worker/test_ddg.py).

    Blocking — callers must run this via run_in_executor (never directly on the
    event loop).
    """
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
        title = a.get_text(" ", strip=True)
        href = _absolute_url(a.get("href", ""), url)
        real_url = _decode_ddg_url(href)
        snippet = s.get_text(" ", strip=True) if s else ""
        results.append(SearchResult(title=title, url=real_url, snippet=snippet))
        if len(results) >= max_results:
            break
    return results[:max_results]


async def google_search(query: str, max_results: int, job_dir: str) -> list[SearchResult]:
    """Playwright Google search.

    Launches a fresh throwaway persistent profile inside {job_dir}/chrome-profile/
    (never a shared or long-lived profile). Raises RuntimeError on CAPTCHA/unusual
    traffic detection.

    """

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
                "https://www.google.com/search?q=" + query,
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
    """Pick the engine from params and return search results (blocking work off-loaded)."""
    engine = params.get("engine", "duckduckgo")
    max_results = int(params.get("max_results", 10))
    max_results = max(1, min(max_results, 50))  # default 10, hard cap 50

    if engine == "google":
        return await google_search(query, max_results, job_dir)
    return await asyncio.get_event_loop().run_in_executor(
        None, duckduckgo_search, query, max_results,
    )


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def extract_emails(text: str) -> set[str]:
    emails: set[str] = set()
    for m in EMAIL_RE.finditer(text):
        email = m.group(0).strip(".")
        domain = email.split("@", 1)[1].lower()
        # Filter out image/asset extensions like .png/.jpg — never real inboxes.

        if ASSET_EXTENSION_RE.search(domain):
            continue
        if "." not in domain:
            # No TLD after then @ — e.g. "user@localhost". Skip.
            continue
        emails.add(email.lower())
    return emails


def extract_phones(text: str) -> set[str]:
    """Standard US phone patterns (with/without +1, area-code parens, dashes/dots/spaces)."""
    phones: set[str] = set()
    for m in PHONE_RE.finditer(text):
        phones.add(_clean_text(m.group(0)))
    return phones


def _meta_content(soup: BeautifulSoup, attr_value: str) -> Optional[str]:
    for el in soup.find_all("meta"):
        if el.get("property") == attr_value or el.get("name") == attr_value:
            content = el.get("content")
            if content:
                return _clean_text(content)
    return None


def _business_name(soup: BeautifulSoup, fallback: str) -> str:
    name = (
        _meta_content(soup, "og:site_name")
        or _meta_content(soup, "og:title")
        or _meta_content(soup, "twitter:site")
    )
    if name:
        return name
    title_tag = soup.find("title")
    if title_tag and title_tag.get_text(strip=True):
        return _clean_text(title_tag.get_text())
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return _clean_text(h1.get_text())
    return fallback


def extract_from_snippet(snippet: str) -> dict:
    """Fallback when the page fetch fails: try pulling contact data straight from the search snippet."""
    return {
        "email": sorted(extract_emails(snippet)),
        "phone": sorted(extract_phones(snippet)),
    }
def extract_lead_page(result: SearchResult) -> Optional[dict]:
    """Fetch one result page and pull email/phone/business metadata.

    Returns None when there is no email AND no phone (skip — don't emit a lead
    with no contact data). On fetch failure, tries the snippet before giving up.
    """

    emails: set[str] = set()
    phones: set[str] = set()
    try:
        resp = requests.get(
            result.url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        page_text = resp.text
    except Exception:
        # Fetch failed — fall back to the search snippet before giving up.
        snippet_data = extract_from_snippet(result.snippet)
        emails = set(snippet_data["email"])
        phones = set(snippet_data["phone"])
        if not emails and not phones:
            return None
        return {
            "email": sorted(emails)[:3],
            "phone": sorted(phones)[:3],
            "businessName": None,
            "contactName": None,
            "website": result.url,
            "sourceUrl": result.url,
            "snippet": result.snippet,
        }

    soup = BeautifulSoup(page_text, "lxml")
    emails = extract_emails(page_text)
    phones = extract_phones(page_text)

    if not emails and not phones:
        return None

    # mailto: hrefs are the strongest signal — surface those first..
    mailtos: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("mailto:"):
            mailtos.update(extract_emails(href))
    ordered_emails = sorted(mailtos) + sorted(emails - mailtos)

    return {
        "email": ordered_emails[:3],
        "phone": sorted(phones)[:3],
        "businessName": _business_name(soup, fallback=result.title),
        "contactName": None,  # Phase 1 — name extraction is a Phase 1.5 item.


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
    """Run a full extraction job: search first, then per-page extraction in a thread pool.

    Streams each non-None lead via `await on_progress(lead)` as they are found.
    """

    loop = asyncio.get_event_loop()
    results = await search_phase(query, params, job_dir)

    leads: list[dict] = []
    seen_urls: set[str] = set()

    for result in results:
        if result.url in seen_urls:
            continue
        lead = await loop.run_in_executor(None, extract_lead_page, result)
        if lead is None:
            continue
        seen_urls.add(result.url)
        leads.append(lead)
        await on_progress(lead)

    return leads