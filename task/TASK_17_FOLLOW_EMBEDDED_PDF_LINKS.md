# Task 17 — Follow PDF links embedded within a result's own page, not just direct-PDF results

**Status: ready to implement.** Written 2026-09-10, confirmed against the real current code in `worker/automation.py` (not assumed).

## The real gap this closes

Confirmed directly in the code: PDF handling only ever triggers when a search **result's own URL** is a PDF (`_is_pdf_result` checks `result.url`, dispatching to `extract_lead_pdf`). There is no code anywhere — confirmed via a full grep for `.pdf`/`href`/`find_all` across `automation.py` — that looks for or follows a PDF link *embedded within* a fetched HTML page. `extract_lead_page(result)` fetches `result.url`, extracts text from that page alone via `soup.get_text()`, and stops there.

In practice, a lot of real search results are regular pages (a business directory entry, a government registry listing, an association member page) that don't have contact info directly in their own visible text, but *do* link out to a PDF (a filing, a license, a member roster, a brochure) that has the actual email/phone/name data. Today those get scanned as plain HTML, the PDF is never discovered, and the result yields zero leads even though the data exists one click away — exactly the pattern behind "it only gets leads from the ones that show a PDF openly in the results list."

## The fix

Reuse the exact same extraction pipeline (`_extract_emails`/`_extract_phones`/`_extract_contact_names`/`_build_leads`) already used for both HTML and PDF text — don't build a second, parallel path. The fetched page's own text and any embedded PDFs' text get concatenated into one combined blob, then extracted once, the same way `extract_lead_page` already does for the page alone today.

### 1. Factor PDF-text-extraction out of `extract_lead_pdf` into a shared helper

`extract_lead_pdf` currently does fetch-PDF-bytes + `PdfReader` + per-page text join all inline. Extract just that part into:

```python
def _fetch_pdf_text(url: str) -> str:
    """Download a PDF and return its extracted text, or "" on any failure
    (unreachable, corrupt, encrypted, scanned-image-only, or pypdf unavailable).
    Shared by extract_lead_pdf (a result that IS a PDF) and extract_lead_page's
    new embedded-PDF-link following (a result whose PAGE links to a PDF).
    """
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": BROWSER_USER_AGENT},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        reader = PdfReader(BytesIO(resp.content))
        if reader.is_encrypted:
            return ""
        page_texts: list[str] = []
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if text.strip():
                page_texts.append(text)
        return "\n".join(page_texts)
    except Exception:
        return ""
```

`extract_lead_pdf` becomes a thin wrapper: call `_fetch_pdf_text(result.url)`, if empty return `[]`, otherwise run the existing `_extract_emails`/`_extract_phones`/`_extract_contact_names`/`_build_leads` sequence exactly as it does today — no behavior change for the direct-PDF-result path, this is a pure refactor for that part.

### 2. New helper: find embedded PDF links in a fetched page

```python
_MAX_EMBEDDED_PDFS_PER_PAGE = 3

def _find_embedded_pdf_links(soup: "BeautifulSoup", base_url: str, limit: int = _MAX_EMBEDDED_PDFS_PER_PAGE) -> list[str]:
    """Scan a parsed page for <a href> links pointing at a PDF (case-insensitive,
    ignoring a trailing query string), resolve each to an absolute URL via the
    existing _absolute_url(), dedupe, and cap at `limit` — a page can link to
    many documents; bound the extra cost rather than following all of them.
    """
    found: list[str] = []
    seen: set[str] = set()
    for a in soup.select("a[href]"):
        href = a.get("href") or ""
        path = href.lower().split("?", 1)[0].rstrip("/")
        if not path.endswith(".pdf"):
            continue
        abs_url = _absolute_url(href, base_url)
        if abs_url in seen:
            continue
        seen.add(abs_url)
        found.append(abs_url)
        if len(found) >= limit:
            break
    return found
```

(`_absolute_url` already exists at line 159 — reuse it, don't reimplement relative-URL resolution.)

### 3. Wire into `extract_lead_page`

After the existing `soup = BeautifulSoup(html, "lxml")` line, before building `page_text`:

```python
combined_text_parts = [soup.get_text(" ", strip=True)]
for pdf_url in _find_embedded_pdf_links(soup, result.url):
    pdf_text = _fetch_pdf_text(pdf_url)
    if pdf_text.strip():
        combined_text_parts.append(pdf_text)
page_text = "\n".join(combined_text_parts)
```

Everything after this point in `extract_lead_page` (the `_extract_emails(page_text, html)` call, etc.) stays **exactly as it is today** — the fix is entirely in what goes into `page_text`, not in how it's used afterward. Note `_extract_emails`/`_extract_phones` also take the raw `html` as a second argument (for mailto: links etc.) — that stays as the ORIGINAL page's `html`, not the PDF's; only the plain-text extraction path benefits from the PDF text, which is correct since a PDF has no HTML `mailto:` links to speak of.

### 4. Attribution stays with the original result, deliberately

Do **not** create a synthetic `SearchResult` pointing at the discovered PDF's URL. Keep calling `_build_leads(result, ...)` with the original `result` — so `businessName`/`website`/`sourceUrl`/`snippet` all still correctly describe the actual business/page the result came from, not the PDF's own (often generic) filename. The PDF is purely a richer *text source* feeding the same extraction, not a new lead-attribution target.

## Explicitly out of scope

- Not changing `_is_pdf_result`/`extract_lead_pdf`'s existing behavior for results that are ALREADY directly a PDF — that path is untouched except for the internal refactor in step 1, which must produce identical output to today.
- Not recursively following PDFs found inside a PDF's own text, or following non-PDF links found on the page — scope is exactly "one level of embedded PDF links, from an HTML result's own page."
- Not making the PDF-link cap (`_MAX_EMBEDDED_PDFS_PER_PAGE = 3`) configurable via job params in this pass — a fixed, reasonable default is enough for now; revisit only if real usage shows 3 is too low or too costly.

## Verification

1. Run the existing test suite / any existing automation.py tests, confirm nothing regresses.
2. Manually test against a real, known example: a search result whose own page has no visible email/phone but links to a PDF that does (a government filing or business-license page is a good real-world test case) — confirm a lead now gets extracted where none did before.
3. Confirm a result that's directly a PDF (`_is_pdf_result` true) still extracts identically to before — the refactor in step 1 must not change that path's output.
4. Confirm a page with NO embedded PDF links behaves exactly as before (no wasted extra HTTP requests, no behavior change).
5. Time a job against a page with several PDF links to confirm the cap (3) is actually bounding the extra requests, not silently following all of them.
