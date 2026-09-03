"""
Phone Number Extractor
Extracts phone numbers from text and HTML content.
"""
from __future__ import annotations
import re


# Phone number patterns (US, international, various formats)
PHONE_PATTERNS = [
    # US formats: (555) 123-4567, 555-123-4567, 555.123.4567
    re.compile(r"\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b"),
    # International: +1-555-123-4567, +44 20 7946 0958
    re.compile(r"\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{1,4}[\s.\-]?\d{1,9}"),
    # With country code: 1-800-555-1234
    re.compile(r"\b1[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}\b"),
]

# Patterns to exclude (dates, zip codes, etc.)
EXCLUDE_PATTERNS = [
    re.compile(r"\b\d{4}[\-/]\d{2}[\-/]\d{2}\b"),  # Dates: 2024-01-15
    re.compile(r"\b\d{2}[\-/]\d{2}[\-/]\d{4}\b"),  # Dates: 01/15/2024
    re.compile(r"\b\d{5}[\-]\d{4}\b"),  # ZIP+4: 12345-6789
]


def extract_phones(text: str, html: str = "") -> list[str]:
    """
    Extract phone numbers from text and HTML content.

    Args:
        text: Plain text content
        html: Raw HTML content

    Returns:
        List of unique phone numbers found
    """
    phones = set()
    search_text = f"{text} {html}" if html else text

    if not search_text:
        return []

    # Look for tel: links in HTML first (most reliable)
    if html:
        tel_pattern = re.compile(r'href=["\']tel:([^"\']+)["\']', re.IGNORECASE)
        for match in tel_pattern.finditer(html):
            phone = clean_phone(match.group(1))
            if phone:
                phones.add(phone)

    # Search with each pattern
    for pattern in PHONE_PATTERNS:
        for match in pattern.finditer(search_text):
            raw = match.group()

            # Check if it matches an exclusion pattern
            is_excluded = False
            for exc_pattern in EXCLUDE_PATTERNS:
                if exc_pattern.match(raw):
                    is_excluded = True
                    break

            if not is_excluded:
                phone = clean_phone(raw)
                if phone and len(phone) >= 10:
                    phones.add(phone)

    return sorted(phones)


def clean_phone(raw: str) -> str:
    """Clean and normalize a phone number string."""
    if not raw:
        return ""

    # Remove common prefixes
    cleaned = raw.strip()

    # Keep only digits, +, -, (, ), spaces
    cleaned = re.sub(r"[^\d+\-() ]", "", cleaned)

    # Remove extra whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # Must have at least 7 digits
    digits_only = re.sub(r"\D", "", cleaned)
    if len(digits_only) < 7 or len(digits_only) > 15:
        return ""

    return cleaned

