#!/usr/bin/env python3
"""Standalone DuckDuckGo plain-HTTP verification (Task 2, Step 0).

RESULT FROM THE ACTUAL REBUILD (run repeatedly against the live endpoint): this is
NOT a reliable "Playwright not needed" verdict either way — across a handful of
realistic lead-gen queries, DuckDuckGo served real `.result` markup roughly half
the time and its real "select all squares containing a duck" anti-bot challenge
(HTTP 202, an `anomaly-modal` div, zero `.result` elements) the other half. It
looks request-dependent (IP reputation and/or query content), not a hard block.
Because of that, worker/automation.py's search_phase() tries this plain-HTTP path
first (cheap) and falls back to a real headless-browser fetch of the same URL
(duckduckgo_search_playwright()) whenever this script's failure mode — zero
`.result` elements / an anomaly-modal challenge — shows up. Re-run this script
any time to get a fresh read for whatever IP it's being run from; a single run
below 5/5 does NOT mean "keep Playwright for everything", and a single run at 5/5
does NOT mean "Playwright is never needed" — this project keeps both, by design.

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

    if "anomaly-modal" in resp.text:
        print("\n⚠️ DDG served its anti-bot 'select the duck squares' challenge this "
              "time (not a hard block — try again, or from a different IP). This is "
              "exactly why automation.py keeps duckduckgo_search_playwright() as a "
              "real fallback rather than removing Playwright from the DDG path.")
        return 1
    if len(results) >= 5:
        print("\n✅ Got real results this run. Re-run a few times, though — this "
              "project's own testing saw this flip to the anti-bot challenge on "
              "roughly half of attempts, so one clean run here isn't proof the "
              "lightweight path alone is reliable enough to drop the Playwright "
              "fallback.")
        return 0
    print("\n⚠️ DDG plain-HTTP returned no anomaly marker but also no .result "
          "elements — inspect the saved response manually, markup may have changed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())