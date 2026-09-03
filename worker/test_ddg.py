#!/usr/bin/env python3
"""Standalone DuckDuckGo plain-HTTP verification (Task 2, Step 0).

Determines whether the DDG extraction path can use `requests` + BeautifulSoup
(dropping the ~300-500MB Chromium/Playwright cost for the default path) or must
keep Playwright.

Usage:
    pip install requests beautifulsoup4 lxml
    python worker/test_ddg.py
"""

import sys

import requests
from bs4 import BeautifulSoup

# Real browser User-Agent — DDG serves (slightly) different markup to
# non-browser clients, so pretend to be a normal desktop Chrome.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

TEST_URL = "https://html.duckduckgo.com/html/?q=plumbers+in+Chicago"


def main() -> int:
    print(f"GET {TEST_URL}")
    resp = requests.get(
        TEST_URL,
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    resp.raise_for_status()
    print(f"HTTP {resp.status_code} — {len(resp.content)} bytes")

    soup = BeautifulSoup(resp.text, "lxml")
    results = soup.select(".result")
    print(f"Found {len(results)} results with selector `.result`\n")

    for i, result in enumerate(results[:5]):
        a = result.select_one(".result__a")
        u = result.select_one(".result__url")
        s = result.select_one(".result__snippet")
        print(f"[{i + 1}]")
        print(f"  title:   {a.get_text(' ', strip=True) if a else None}")
        print(f"  href:    {a.get('href') if a else None}")
        print(f"  url:     {u.get_text(' ', strip=True) if u else None}")
        print(f"  snippet: {s.get_text(' ', strip=True) if s else None}")

    if len(results) >= 5:
        print("\n✅ DDG plain-HTTP works — Playwright NOT needed for DDG path")
        return 0
    print("\n⚠️ DDG plain-HTTP failed — keep Playwright for DDG")
    return 1


if __name__ == "__main__":
    sys.exit(main())