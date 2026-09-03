"""
Extracted from lead-extractor's app/export/exporter.py — only the two
self-contained functions needed by filters/email_domain_rules.py. Deliberately
NOT importing exporter.py itself, which pulls in app.config (that module holds
lead-extractor's commercial license-validation secret and has no business
being anywhere near this repo).
"""
from __future__ import annotations

import re

from extractors.email_extractor import extract_emails


def _coerce_email_string(s: str) -> str | None:
    """Strip mailto:, angle brackets, trailing punctuation — one candidate string."""
    t = (s or "").strip().replace("\n", " ").replace("\r", "")
    if not t or "@" not in t:
        return None
    if t.lower().startswith("mailto:"):
        t = t[7:].split("?")[0].strip()
    m = re.search(r"<([a-zA-Z0-9._%+\-]+@[^>\s]+)>", t)
    if m:
        t = m.group(1).strip()
    t = t.rstrip(".,;)>]\"'").strip()
    return t if "@" in t else None


def normalize_email_cell_to_addresses(raw: str | None) -> list[str]:
    """
    Parse one database `email` cell into 0..N addresses (lowercased, trailing dot stripped).
    Handles comma/space-separated lists and messy PDF extractions the same way as extraction.
    """
    if raw is None or not str(raw).strip():
        return []
    s = str(raw).strip()
    found = extract_emails(s, "")
    if found:
        return found
    coerced = _coerce_email_string(s)
    if not coerced:
        return []
    found2 = extract_emails(coerced, "")
    if found2:
        return found2
    c = coerced.lower().strip().rstrip(".")
    return [c] if "@" in c and "." in c.split("@", 1)[-1] else []
