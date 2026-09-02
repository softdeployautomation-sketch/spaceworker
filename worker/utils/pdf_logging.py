"""
Reduce terminal noise from pdfminer.six when parsing PDFs that use Pattern color spaces.

Those PDFs pass names like /P0 where pdfminer expects a gray float; text extraction
still works — only rendering-state warnings are emitted.
"""
from __future__ import annotations

import logging

_CONFIGURED = False


def suppress_pdfminer_color_warnings() -> None:
    """Call once at process startup (before or after importing pdfplumber)."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    for name in (
        "pdfminer.pdfinterp",
        "pdfminer.pdfpage",
        "pdfminer.converter",
        "pdfminer.pdfdevice",
    ):
        logging.getLogger(name).setLevel(logging.ERROR)
    _CONFIGURED = True
