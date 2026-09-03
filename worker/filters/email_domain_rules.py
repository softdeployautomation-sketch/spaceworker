"""
Email domain allowlist / site: restriction for search + export.

Design (industry-typical):
- **Search `site:`** — limits the search engine to pages on those hosts (Google/DuckDuckGo).
  Use registrable domains (e.g. harvard.edu, redcross.org). Does not filter by mailbox
  domain (@gmail.com); combine with allowlist for that.
- **Email domain allowlist** — after extraction (or before download), keep only leads where
  at least one address in the email field matches.

Syntax (one rule per line, commas also split):
  gmail.com          → matches user@gmail.com (and subdomains like user@mail.gmail.com)
  @yahoo.com         → same
  *.edu              → any domain ending in .edu (utexas.edu, student.columbia.edu)
  .gov               → same as *.gov

Lines starting with # are comments. Empty lines ignored.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from worker.utils.email_normalize import normalize_email_cell_to_addresses

# Reasonable hostname for site: / exact domain rules (no path, no port)
_DOMAIN_LABEL = r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)"
_DOMAIN_RE = re.compile(
    rf"^{_DOMAIN_LABEL}(?:\.{_DOMAIN_LABEL})+$",
    re.IGNORECASE,
)


def _strip_comment(line: str) -> str:
    if "#" in line:
        line = line.split("#", 1)[0]
    return line.strip()


def _split_lines_and_commas(text: str | None) -> list[str]:
    if not text or not str(text).strip():
        return []
    parts: list[str] = []
    for line in str(text).splitlines():
        line = _strip_comment(line)
        if not line:
            continue
        for chunk in line.split(","):
            t = chunk.strip()
            if t:
                parts.append(t)
    return parts


def normalize_domain_token(raw: str) -> str | None:
    """Lowercase host token without scheme/path; None if invalid."""
    t = (raw or "").strip().lower()
    if not t:
        return None
    t = t.removeprefix("@")
    t = t.strip().strip(".")
    # strip accidental URL prefix
    for prefix in ("http://", "https://", "//"):
        if t.startswith(prefix):
            t = t[len(prefix) :].split("/")[0].split(":")[0]
    if not t or "." not in t:
        return None
    if not _DOMAIN_RE.match(t):
        return None
    return t


@dataclass
class EmailDomainRules:
    """Exact / subdomain rules plus suffix rules (*.edu)."""

    exact_domains: list[str] = field(default_factory=list)
    suffixes: list[str] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.exact_domains and not self.suffixes


def parse_email_domain_allowlist(text: str | None) -> EmailDomainRules:
    """
    Parse textarea / setting string into rules.
    *.suffix or .suffix → suffix match on the email host (e.g. *.edu).
    """
    exact: list[str] = []
    suffixes: list[str] = []
    seen_e: set[str] = set()
    seen_s: set[str] = set()
    for raw in _split_lines_and_commas(text):
        r = raw.strip().lower()
        if r.startswith("*.") and len(r) > 2:
            suf = r[2:].strip().strip(".")
            if suf and suf not in seen_s:
                seen_s.add(suf)
                suffixes.append(suf)
            continue
        if r.startswith(".") and len(r) > 1:
            suf = r[1:].strip().strip(".")
            if suf and suf not in seen_s:
                seen_s.add(suf)
                suffixes.append(suf)
            continue
        d = normalize_domain_token(raw)
        if d and d not in seen_e:
            seen_e.add(d)
            exact.append(d)
    return EmailDomainRules(exact_domains=exact, suffixes=suffixes)


def _host_matches_exact(email_host: str, domain: str) -> bool:
    h = email_host.lower().strip().rstrip(".")
    d = domain.lower().strip().rstrip(".")
    return h == d or h.endswith("." + d)


def _host_matches_suffix(email_host: str, suffix: str) -> bool:
    h = email_host.lower().rstrip(".")
    s = suffix.lower().strip().lstrip(".")
    if not s:
        return False
    return h == s or h.endswith("." + s)


def email_matches_rules(email_address: str, rules: EmailDomainRules) -> bool:
    if rules.is_empty() or not email_address or "@" not in email_address:
        return False
    host = email_address.rsplit("@", 1)[-1].strip().lower().rstrip(".")
    if not host:
        return False
    for d in rules.exact_domains:
        if _host_matches_exact(host, d):
            return True
    for s in rules.suffixes:
        if _host_matches_suffix(host, s):
            return True
    return False


def lead_row_matches_email_rules(lead: dict, rules: EmailDomainRules) -> bool:
    """True if any parsed address from the row's email field matches."""
    if rules.is_empty():
        return True
    addrs = normalize_email_cell_to_addresses(lead.get("email"))
    if not addrs:
        return False
    return any(email_matches_rules(a, rules) for a in addrs)


def filter_leads_by_email_domains(
    leads: list[dict],
    rules: EmailDomainRules | None,
) -> tuple[list[dict], int]:
    """
    Drop leads that do not match rules. If rules empty, return leads unchanged.
    Returns (kept, dropped_count).
    """
    if not leads:
        return [], 0
    if rules is None or rules.is_empty():
        return list(leads), 0
    kept: list[dict] = []
    dropped = 0
    for row in leads:
        if lead_row_matches_email_rules(row, rules):
            kept.append(row)
        else:
            dropped += 1
    return kept, dropped


# Users often enter the *search engine* or a social app here. `site:google.com` does NOT mean
# “search with Google” — it means “only pages whose URL is on google.com”, which kills PDF discovery.
_SITE_HOST_SEARCH_AND_SOCIAL_PORTALS = frozenset(
    {
        "google.com",
        "gstatic.com",
        "googleusercontent.com",
        "facebook.com",
        "fb.com",
        "m.facebook.com",
        "instagram.com",
        "threads.net",
        "twitter.com",
        "x.com",
        "t.co",
        "linkedin.com",
        "bing.com",
        "duckduckgo.com",
        "yahoo.com",
        "msn.com",
        "youtube.com",
        "youtu.be",
        "tiktok.com",
        "pinterest.com",
        "snapchat.com",
    }
)


def _registrable_root_for_portal_check(hostname: str) -> str:
    h = (hostname or "").strip().lower().rstrip(".")
    if h.startswith("www."):
        h = h[4:]
    return h


def _is_blocked_search_portal_domain(hostname: str) -> bool:
    root = _registrable_root_for_portal_check(hostname)
    if root in _SITE_HOST_SEARCH_AND_SOCIAL_PORTALS:
        return True
    # e.g. mail.google.com, apis.google.com
    for portal in ("google.com", "facebook.com", "yahoo.com", "bing.com"):
        if root == portal or root.endswith("." + portal):
            return True
    return False


def parse_site_domains_for_search(text: str | None) -> tuple[list[str], list[str]]:
    """
    Domains for site: operator. Ignores *.wildcard-only lines (not valid for site:).

    Returns (accepted_domains, skipped_portal_domains). Portal/social/search domains are skipped
    because they almost never host the PDF rosters this app looks for, and they confuse users.
    """
    out: list[str] = []
    skipped: list[str] = []
    seen: set[str] = set()
    seen_skip: set[str] = set()
    for raw in _split_lines_and_commas(text):
        r = raw.strip().lower()
        if r.startswith("*.") or (r.startswith(".") and len(r) > 1):
            continue
        d = normalize_domain_token(raw)
        if not d or d in seen or d in seen_skip:
            continue
        if _is_blocked_search_portal_domain(d):
            seen_skip.add(d)
            skipped.append(d)
            continue
        seen.add(d)
        out.append(d)
    return out, skipped


def domains_to_site_clause(domains: list[str]) -> str:
    """Build (site:a OR site:b) from normalized host list."""
    if not domains:
        return ""
    parts = [f"site:{d}" for d in domains]
    if len(parts) == 1:
        return parts[0]
    return "(" + " OR ".join(parts) + ")"


def _is_pdf_rare_site_host(normalized_domain: str) -> bool:
    """
    Hosts where forcing filetype:pdf on every query almost always yields empty SERPs
    (discussion / social threads, not PDF file servers).
    """
    d = (normalized_domain or "").strip().lower().rstrip(".")
    if not d:
        return False
    if d == "redd.it" or d.endswith(".redd.it"):
        return True
    if d == "reddit.com" or d.endswith(".reddit.com"):
        return True
    return False


def site_restriction_targets_only_pdf_rare_hosts(accepted_domains: list[str]) -> bool:
    """
    True when every accepted site: host is PDF-rare (e.g. only Reddit).
    DuckDuckGo flow should omit filetype:pdf and may scrape thread HTML from result URLs.
    """
    if not accepted_domains:
        return False
    return all(_is_pdf_rare_site_host(x) for x in accepted_domains)


def build_site_restriction_clause(site_domains_text: str | None) -> str:
    """
    Build a search-engine clause: (site:a.com OR site:b.org)
    Empty if no valid domains. Drops search/social portal domains (see parse_site_domains_for_search).
    """
    domains, _skipped = parse_site_domains_for_search(site_domains_text)
    return domains_to_site_clause(domains)


def prepare_site_restriction_for_automation(site_domains_text: str | None) -> tuple[str, list[str], list[str]]:
    """
    Returns (site_clause, skipped_portal_domains, accepted_domains) for automation + messaging.
    """
    domains, skipped = parse_site_domains_for_search(site_domains_text)
    return domains_to_site_clause(domains), skipped, domains


def apply_site_restriction_to_query(query: str, site_clause: str) -> str:
    """Append site: restriction without dropping user's keywords."""
    q = (query or "").strip()
    if not site_clause:
        return q
    if not q:
        return site_clause
    return f"({q}) {site_clause}".strip()
