# SpaceWorker Local Extraction Engine

A standalone, dependency-free TypeScript module that ports the **deterministic core**
of the production Python extraction worker (`../worker/*` in this repo) into a pure JS
module the desktop **Extractor EXE** (Task 27 Part A) is intended to run, and that the
repo's own test runner can verify in isolation.

> **Status (2026-09-15):** slices **0.1.0** (deterministic core), **0.2.0** (HTML page-crawl
layer), and **0.3.0** (PDF sniffing + text extraction) of Task 27 Part A's "ported local
extraction engine" are done and verified. Per the plan's 2026-09-15 update, the Extractor
EXE build is the immediate priority (a paying customer is waiting on it); this module is
its extraction + crawl + PDF foundation, ported first and sorted into surface area so each
slice is testable in isolation.

## Dependencies

The module is otherwise **dependency-free** (pure regex / built-in `node:` APIs), with one
deliberate exception: **`pdfjs-dist`** (the PDF rendering engine Firefox uses) for the
byte-to-text step of PDF parsing. PDF is a binary format — not reasonably hand-rollable the
way the HTML scanner was. `pdfjs-dist` is loaded **lazily** (dynamic import inside
`parsePdfTextWithPdfjs`), so cheap-to-parse paths stay light. Added to the repo root
`package.json` (the module shares the repo's `tsx`/`typescript` toolchain).

## What's ported

Pure regex string processing (zero I/O — no browser/network/DB/Next.js):

| Module (`src/…`) | Ports | Origin (Python) |
| --- | --- | --- |
| `extractors/email.ts` | `extractEmails` | `worker/extractors/email_extractor.py` |
| `extractors/name.ts` | `extractBusinessName`, `extractContactNames`, `extractNamesFromEmail` | `worker/extractors/name_extractor.py` |
| `extractors/phone.ts` | `extractPhones`, `cleanPhone` | `worker/extractors/phone_extractor.py` |
| `utils/email-normalize.ts` | `coerceEmailString`, `normalizeEmailCellToAddresses` | `worker/utils/email_normalize.py` |
| `filters/email-domain-rules.ts` | allowlist + site: restriction builder/matcher | `worker/filters/email_domain_rules.py` |
| `query.ts` | `EXPANSION_SUFFIXES`, `SUFFIX_PAIR_INDICES`, `roundQueries` (+ `biasQueryTowardPdfs`) | `worker/automation.py` |
| `lead.ts` | `SearchResult`, `buildLeads` | `worker/automation.py` (`_build_leads`) |

HTML page-crawl layer (parsing/decision logic only — I/O injected by the caller):

| Module (`src/…`) | Ports | Origin (Python) |
| --- | --- | --- |
| `html.ts` | `htmlToText`, `extractAnchors`, `scanHtml` (get_text/find_all stand-ins), `absoluteUrl`, `decodeDdgUrl`, `findContactLinks` (`_find_contact_links`), `findEmbeddedPdfLinks`, `netlocOf` | `worker/automation.py` + a self-contained HTML scanner (BeautifulSoup/lxml stand-in) |
| `crawl.ts` | `extractLeadPage`, `extractLeadPdf`, `leadsFromPageText` (+ default `fetch`-based `defaultFetcher`) | `worker/automation.py` (`extract_lead_page` / `extract_lead_pdf`) |
| `pdf.ts` | `isPdfUrlPath`, `isPdfContentType`, `sniffPdfMagic`, `isPdfResult` (Injected HEAD/GET probe → `defaultProbe`) | `worker/automation.py` (`_is_pdf_result`) — sniffing only, no binary parsing |
| `pdf-text.ts` | `fetchPdfText`, `parsePdfTextWithPdfjs`, `defaultPdfTextDeps` | `worker/automation.py` (`_fetch_pdf_text`) — byte→text uses **pdfjs-dist** (lazy-loaded) |

## Still out of scope (the remaining I/O / orchestration)

Not ported because they can't run "in isolation" — they need a browser/network and a store:

- **search crawling** (DuckDuckGo HTTP/Playwright, Google pagination, exit-node proxies, CAPTCHA handling) — `search_phase` & friends,
- **PDF detection dispatch** (`_extract_result` choosing the PDF vs page extractor) — the two extractors exist (`extractLeadPdf`/`extractLeadPage`) and the `_is_pdf_result` sniffing is done; wiring them together lives with the search/job layer,
- **job scheduling / progress / persistence** (`run_automation`, `_search_and_extract`, DB writes).

Network I/O is *injected* throughout (`CrawlDeps.fetchHtml`/`fetchPdfText`, `PdfProbeDeps`, `PdfTextDeps.fetchBytes`), so every layer is testable without a network while still running for real in the desktop EXE.

## Fidelity notes

- Rewrites are **behavioral ports**, kept line-by-line faithful to the Python originals
  (including quirks, e.g. `extractPhones` scans `text + html` and can double-count a
  `tel:` value; `extractBusinessName` strips corporate tags sequentially).
- The Python source's `_EXPANSION_SUFFIXES` comment says "28 suffixes → C(28,2)=378",
  but the actual list holds **29** entries. This port follows the real list (29 → 406
  pairs); see `test/query.test.ts`.
- If the Python engine changes, mirror the change here (and its tests) — do not drift.

## Run the tests / type-check

```bash
npm run test:engine          # tsx --test local-engine/test/**/*.test.ts
npm run typecheck:engine     # tsc -p local-engine/tsconfig.json
```

Tests use Node's built-in runner (`node:test`) via `tsx` (already a devDependency of
this repo) — no extra test framework or runtime dependencies.