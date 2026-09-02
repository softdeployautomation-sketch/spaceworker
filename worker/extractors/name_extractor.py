"""
Name Extractor
Extracts person and business names from text content using pattern matching.
"""
from __future__ import annotations
import re


def extract_business_name(title: str, url: str, snippet: str = "") -> str:
    """
    Extract the most likely business name from a search result.

    Args:
        title: Page title from search result
        url: Page URL
        snippet: Search result snippet

    Returns:
        Best guess at business name
    """
    if not title:
        return ""

    # Clean the title - remove common suffixes
    name = title.strip()

    # Remove common title separators and what follows
    separators = [" | ", " - ", " – ", " — ", " :: ", " >> ", " : "]
    for sep in separators:
        if sep in name:
            # Usually the business name is the first part
            parts = name.split(sep)
            # Filter out very short parts and common page names
            common_pages = {
                "home", "about", "contact", "services", "products",
                "blog", "news", "faq", "help", "login", "sign up",
                "about us", "contact us", "our services",
            }
            for part in parts:
                part_clean = part.strip()
                if part_clean.lower() not in common_pages and len(part_clean) > 2:
                    name = part_clean
                    break
            break

    # Remove trailing common words
    trailing_patterns = [
        r"\s*[-–—]\s*Home\s*$",
        r"\s*[-–—]\s*Official Site\s*$",
        r"\s*[-–—]\s*Official Website\s*$",
        r"\s*\|\s*Home\s*$",
        r"\s*®\s*$",
        r"\s*™\s*$",
        r"\s*Inc\.?\s*$",
        r"\s*LLC\.?\s*$",
        r"\s*Ltd\.?\s*$",
        r"\s*Corp\.?\s*$",
    ]
    for pattern in trailing_patterns:
        name = re.sub(pattern, "", name, flags=re.IGNORECASE).strip()

    return name if len(name) > 1 else ""


def extract_contact_names(text: str) -> list[str]:
    """
    Extract potential person names from text content.
    Uses common patterns like titles and contact sections.

    Args:
        text: Page text content

    Returns:
        List of potential person names found
    """
    names = set()

    # Pattern: Title + Name (e.g., "Dr. John Smith", "Mr. Jane Doe")
    title_pattern = re.compile(
        r"\b(Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Sr|Jr)"
        r"\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b"
    )
    for match in title_pattern.finditer(text):
        full_name = f"{match.group(1)}. {match.group(2)}"
        names.add(full_name)

    # Pattern: "Contact: Name" or "Contact Person: Name"
    contact_pattern = re.compile(
        r"(?:contact(?:\s+person)?|owner|manager|director|ceo|founder|president)"
        r"\s*[:\-–]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})",
        re.IGNORECASE,
    )
    for match in contact_pattern.finditer(text):
        names.add(match.group(1).strip())

    # Pattern: "By FirstName LastName" (author attribution)
    author_pattern = re.compile(
        r"\b(?:by|author|written by|posted by)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b"
    )
    for match in author_pattern.finditer(text):
        names.add(match.group(1).strip())

    return sorted(names)


def extract_names_from_email(email: str) -> str:
    """
    Attempt to derive a name from an email address.
    e.g., john.smith@company.com -> John Smith

    Args:
        email: Email address

    Returns:
        Derived name or empty string
    """
    if not email or "@" not in email:
        return ""

    local_part = email.split("@")[0]

    # Common separators in email local parts
    for sep in [".", "_", "-"]:
        if sep in local_part:
            parts = local_part.split(sep)
            # Filter out numbers and very short parts
            name_parts = [
                p.capitalize()
                for p in parts
                if len(p) > 1 and not p.isdigit() and p.isalpha()
            ]
            if len(name_parts) >= 2:
                return " ".join(name_parts[:3])  # Max 3 parts
            break

    return ""

