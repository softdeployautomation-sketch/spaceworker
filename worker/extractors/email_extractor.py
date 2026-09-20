"""
Email Extractor
Extracts email addresses from text and HTML content.
"""
from __future__ import annotations
import re
from urllib.parse import unquote


# Comprehensive email regex
EMAIL_PATTERN = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
    re.IGNORECASE,
)

# Common junk/false-positive emails to filter out
JUNK_DOMAINS = {
    "example.com",
    "example.org",
    "test.com",
    "sentry.io",
    "wixpress.com",
    "wordpress.com",
    "w3.org",
    "schema.org",
    "googleapis.com",
    "googleusercontent.com",
    "gstatic.com",
    "facebook.com",
    "twitter.com",
    "instagram.com",
}

JUNK_PREFIXES = {
    "noreply",
    "no-reply",
    "mailer-daemon",
    "postmaster",
    "webmaster",
    "abuse",
    "admin@wordpress",
}

# Exact full addresses, not prefix/domain patterns — well-known HTML form
# PLACEHOLDER text (e.g. <input placeholder="you@email.com">) that leaks
# into extracted page text as if it were a real address. Confirmed live
# 2026-09-20: "you@email.com" was saved as a real lead on 360dentalcare.co.uk.
# "email.com" itself is a real, legitimate domain (a legacy free webmail
# provider) so it can't be blanket-excluded the way JUNK_DOMAINS entries
# are — only these specific well-known placeholder addresses are.
JUNK_EMAILS = {
    "you@email.com", "your@email.com", "user@email.com", "name@email.com",
    "email@email.com", "your.email@email.com", "yourname@email.com",
    "youremail@email.com",
}

# File extensions that look like email TLDs but aren't
FALSE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js", ".webp"}

# A 24+ char local-part that's ALL hex characters is virtually never a real
# human email — it's a tracking/session/error-report ID a JS SDK embedded in
# the page (Sentry, analytics, error monitors) formatted email-shaped by
# coincidence (hex-id@vendor-subdomain.com). Confirmed live 2026-09-20:
# "18d2f96d279149989b95faf0a4b41882@sentry-next.wixpress.com" was saved as a
# real lead's email — a Sentry error-tracking ID, not a person. Generic
# guard, not tied to one vendor's domain, since new tracking domains appear
# constantly and a domain blocklist alone can never be complete.
_HEX_ID_RE = re.compile(r"^[a-f0-9]{24,}$")


def extract_emails(text: str, html: str = "") -> list[str]:
    """
    Extract unique email addresses from text and HTML content.

    Args:
        text: Plain text content
        html: Raw HTML content (for mailto: links etc.)

    Returns:
        List of unique, cleaned email addresses
    """
    emails = set()

    # Extract from plain text
    if text:
        found = EMAIL_PATTERN.findall(text)
        emails.update(found)

    # Extract from HTML (especially mailto: links)
    if html:
        # Find mailto: links
        mailto_pattern = re.compile(r"mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})", re.IGNORECASE)
        mailto_found = mailto_pattern.findall(html)
        emails.update(mailto_found)

        # Also search decoded HTML
        decoded_html = unquote(html)
        found = EMAIL_PATTERN.findall(decoded_html)
        emails.update(found)

    # Clean and filter
    cleaned = []
    for email in emails:
        email = email.lower().strip().rstrip(".")
        # A real email's local-part can never start with "." (RFC 5321/5322) --
        # confirmed live from real extracted output (".574@hotmail.com",
        # ".perez@gmail.com"): adjacent source-text punctuation (a bullet point,
        # a list number, an ellipsis) bleeds into the regex match as a leading
        # dot, since the character class legitimately allows "." WITHIN a local
        # part and has no way to know it's actually the FIRST character. Strip
        # any leading dots from the local-part specifically -- recovers the
        # real email underneath rather than silently keeping an invalid one or
        # discarding a genuine lead outright.
        if "@" in email:
            local, _, domain_part = email.partition("@")
            local = local.lstrip(".")
            if local:
                email = f"{local}@{domain_part}"

        # Skip known placeholder addresses (see JUNK_EMAILS above).
        if email in JUNK_EMAILS:
            continue

        # Skip junk domains — subdomains too. Confirmed live 2026-09-20: an
        # exact-match-only check missed "sentry-next.wixpress.com" despite
        # "wixpress.com" already being listed, because it's a subdomain, not
        # the bare domain. A real subsidiary/regional site legitimately
        # living at a subdomain of a real business's own domain is not at
        # risk here — every entry in JUNK_DOMAINS is third-party platform/
        # tracking infrastructure, never a business's own domain.
        domain = email.split("@")[-1] if "@" in email else ""
        if domain in JUNK_DOMAINS or any(domain.endswith("." + jd) for jd in JUNK_DOMAINS):
            continue

        # Skip junk prefixes
        prefix = email.split("@")[0] if "@" in email else ""
        if any(prefix.startswith(jp) for jp in JUNK_PREFIXES):
            continue

        # Skip machine-generated tracking/session IDs shaped like an email
        # (see _HEX_ID_RE above) — a real person's local-part is never a
        # bare 24+ char hex string.
        if _HEX_ID_RE.match(prefix):
            continue

        # Skip false extensions (e.g., image@2x.png)
        if any(email.endswith(ext) for ext in FALSE_EXTENSIONS):
            continue

        # Basic validation: must have @ and at least one dot after @
        if "@" in email and "." in email.split("@")[-1]:
            cleaned.append(email)

    # Sort and deduplicate
    return sorted(set(cleaned))

