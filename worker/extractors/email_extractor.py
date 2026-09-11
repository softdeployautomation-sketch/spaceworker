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

# File extensions that look like email TLDs but aren't
FALSE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".css", ".js", ".webp"}


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

        # Skip junk domains
        domain = email.split("@")[-1] if "@" in email else ""
        if domain in JUNK_DOMAINS:
            continue

        # Skip junk prefixes
        prefix = email.split("@")[0] if "@" in email else ""
        if any(prefix.startswith(jp) for jp in JUNK_PREFIXES):
            continue

        # Skip false extensions (e.g., image@2x.png)
        if any(email.endswith(ext) for ext in FALSE_EXTENSIONS):
            continue

        # Basic validation: must have @ and at least one dot after @
        if "@" in email and "." in email.split("@")[-1]:
            cleaned.append(email)

    # Sort and deduplicate
    return sorted(set(cleaned))

