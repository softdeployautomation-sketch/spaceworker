"""
Self-hosted webmail platform targeting — two independent modes:

1. SEARCH mode (build_webmail_dork_clause): find webmail LOGIN pages directly
   via the search engine's own index, using `intitle:` — the same dork-based
   discovery technique this app already relies on for PDF roster discovery
   (see _bias_query_toward_pdfs in automation.py). Each hit's DOMAIN becomes
   the lead (no email/phone on a login page itself), tagged with the detected
   platform. Fast — no extra network requests beyond the normal search.

2. VERIFY/PROBE mode (probe_domain_for_webmail): for leads found the normal
   way, actively fetch a handful of candidate URLs on the lead's OWN domain
   (webmail.<domain>, mail.<domain>, etc.) and check for a fingerprint match.
   Slower — real extra HTTP requests per lead — used to confirm/filter leads
   by mail platform rather than to source them.

Fingerprints below are sourced directly from Wappalyzer's open-source
technology database (github.com/enthec/webappanalyzer, category 30 "Webmail"),
restricted to the self-hosted platforms a "roundcube kind of webmail" request
actually means — Google Workspace / Microsoft 365 / Proton Mail / iCloud Mail
are deliberately excluded; they're exactly what this feature is meant to find
alternatives to, not targets for it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class WebmailPlatform:
    code: str
    label: str
    # Search-engine title dork — matches the platform's login-page <title>.
    dork_title: str
    # Regexes checked against fetched HTML (title text, inline <script> content,
    # cookie names) to CONFIRM a real match, not just trust the page title —
    # guards against a false-positive title hit from an unrelated indexed page.
    html_patterns: tuple[str, ...]


WEBMAIL_PLATFORMS: dict[str, WebmailPlatform] = {
    "roundcube": WebmailPlatform(
        code="roundcube",
        label="RoundCube",
        dork_title="RoundCube Webmail",
        html_patterns=(r"<title>\s*RoundCube", r"\brcmail\b", r"\broundcube\b"),
    ),
    "squirrelmail": WebmailPlatform(
        code="squirrelmail",
        label="SquirrelMail",
        dork_title="SquirrelMail",
        html_patterns=(r"SquirrelMail version", r"squirrelmail_loginpage_onload"),
    ),
    "rainloop": WebmailPlatform(
        code="rainloop",
        label="RainLoop",
        dork_title="RainLoop Webmail",
        html_patterns=(r"rainloop/v/[\d.]+/static", r"\brainloop\b", r"rlAppVersion"),
    ),
    "zimbra": WebmailPlatform(
        code="zimbra",
        label="Zimbra",
        dork_title="Zimbra Web Client",
        html_patterns=(r"Zimbra Web Client", r"\bzimbraMail\b"),
    ),
    "open-xchange": WebmailPlatform(
        code="open-xchange",
        label="Open-Xchange",
        dork_title="Open-Xchange",
        html_patterns=(r"open-xchange-appsuite", r"#io-ox-core"),
    ),
    # Added 2026-09-20 after real probing of 12 live business domains across
    # Nigeria, Kenya, Ghana, the US and the UK (see chat/commit): cPanel's own
    # webmail portal (its title/theme selector in front of RoundCube/Horde/
    # SquirrelMail) was the SINGLE MOST COMMON self-hosted webmail wrapper
    # found — 7 of 12 real hits, vs 1 for raw RoundCube (our only prior
    # match). dork_title is deliberately weak/noisy here ("Webmail Login" is
    # cPanel's generic page title, shared by countless unrelated products) —
    # this platform's real value is VERIFY/PROBE mode, matched on structural
    # markers instead of the title.
    "cpanel": WebmailPlatform(
        code="cpanel",
        label="cPanel Webmail",
        dork_title="Webmail Login",
        html_patterns=(r"cPanel_magic_revision", r"/unprotected/cpanel/"),
    ),
}

# Reasonable, bounded candidate paths for the PROBE mode — checked in this
# order, stopping at the first confirmed match (see the automation.py caller).
# Deliberately short: this list adds real wall-clock time per lead.
_CANDIDATE_SUBDOMAINS = ("webmail", "mail")
_CANDIDATE_PATHS = ("/webmail", "/roundcube")


def build_webmail_dork_clause(platform_codes: list[str]) -> str:
    """(intitle:"RoundCube Webmail" OR intitle:"SquirrelMail" ...) for the
    selected platforms. Empty string when no valid codes are given."""
    titles = [
        WEBMAIL_PLATFORMS[code].dork_title
        for code in platform_codes
        if code in WEBMAIL_PLATFORMS
    ]
    if not titles:
        return ""
    parts = [f'intitle:"{t}"' for t in dict.fromkeys(titles)]  # de-dup, keep order
    if len(parts) == 1:
        return parts[0]
    return "(" + " OR ".join(parts) + ")"


def apply_webmail_bias_to_query(query: str, platform_codes: list[str]) -> str:
    """Returns the webmail dork clause ALONE — the caller's free-text query is
    deliberately DROPPED, not appended.

    Confirmed live (2026-09-19) — this used to append the dork clause to the
    caller's "find in location" text (same shape as _bias_query_toward_pdfs),
    which sounded reasonable but produced zero real results: manually tested
    against real search results, a query like
    `law firm in Lagos (intitle:"RoundCube Webmail" OR intitle:"SquirrelMail" ...)`
    made the search engine silently DROP the intitle: constraints entirely and
    fall back to generic "law firm in Lagos" hits — confirmed by the search
    results themselves, not assumed. A webmail login page's title has nothing
    to do with what business runs it, so there's no text on that page for a
    combined query to legitimately match anyway. `intitle:"RoundCube Webmail"`
    ALONE (no other terms) reliably returns real, live login pages — confirmed
    with multiple real samples (webmail.digipen.edu, mail.egr.msu.edu,
    webmail.supremecluster.com, mail.ovh.net, and others)."""
    return build_webmail_dork_clause(platform_codes)


def detect_webmail_platform(html: str, platform_codes: list[str] | None = None) -> str | None:
    """Returns the matched platform's label, or None. Checked against the
    given codes if provided, else all known platforms."""
    if not html:
        return None
    candidates = (
        [WEBMAIL_PLATFORMS[c] for c in platform_codes if c in WEBMAIL_PLATFORMS]
        if platform_codes
        else list(WEBMAIL_PLATFORMS.values())
    )
    for platform in candidates:
        for pattern in platform.html_patterns:
            if re.search(pattern, html, re.IGNORECASE):
                return platform.label
    return None


def candidate_webmail_urls(domain: str) -> list[str]:
    """Bounded list of likely webmail URLs for a domain, checked in order by
    the PROBE mode (short-circuits on first confirmed match)."""
    d = (domain or "").strip().lower()
    if not d:
        return []
    d = re.sub(r"^https?://", "", d).split("/")[0].removeprefix("www.")
    if not d:
        return []
    urls: list[str] = []
    for sub in _CANDIDATE_SUBDOMAINS:
        urls.append(f"https://{sub}.{d}/")
    for path in _CANDIDATE_PATHS:
        urls.append(f"https://{d}{path}")
    return urls
