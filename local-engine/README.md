# SpaceWorker Local Extraction Engine

A standalone, dependency-free TypeScript module that ports the **deterministic core**
of the production Python extraction worker (`../worker/*` in this repo) into a pure JS
module the desktop **Extractor EXE** (Task 27 Part A) is intended to run, and that the
repo's own test runner can verify in isolation.

> **Status (2026-09-15):** this is the first slice of Task 27 Part A's "ported local
extraction engine". Per the plan's 2026-09-15 update, the Extractor EXE build is the
immediate priority (a paying customer is waiting on it); this module is its deterministic
foundation, ported first because it's the part testable in isolation.

## What's ported (pure regex string processing — zero I/O, no browser/network/DB/Next.js)

| Module (`src/…`) | Ports | Origin (Python) |
| --- | --- | --- |
| `extractors/email.ts` | `extractEmails` | `worker/extractors/email_extractor.py` |
| `extractors/name.ts` | `extractBusinessName`, `extractContactNames`, `extractNamesFromEmail` | `worker/extractors/name_extractor.py` |
| `extractors/phone.ts` | `extractPhones`, `cleanPhone` | `worker/extractors/phone_extractor.py` |
| `utils/email-normalize.ts` | `coerceEmailString`, `normalizeEmailCellToAddresses` | `worker/utils/email_normalize.py` |
| `filters/email-domain-rules.ts` | allowlist + site: restriction builder/matcher | `worker/filters/email_domain_rules.py` |
| `query.ts` | `EXPANSION_SUFFIXES`, `SUFFIX_PAIR_INDICES`, `roundQueries` (+ `biasQueryTowardPdfs`) | `worker/automation.py` |
| `lead.ts` | `SearchResult`, `buildLeads` | `worker/automation.py` (`_build_leads`) |

## Explicitly out of scope (the I/O layer — not part of this isolated module)

The engine's I/O / orchestration layer is intentionally **not** ported here because it
cannot run "in isolation" — it needs a browser + network + an HTML/PDF parser and a store:

- search crawling (DuckDuckGo HTTP/Playwright, Google pagination, exit-node proxies, CAPTCHA handling),
- `requests` page/PDF fetching, PDF detection (`_is_pdf_result`) + parse (`_fetch_pdf_text`),
- HTML page crawling incl. contact-link discovery (`_find_contact_links` — needs an HTML parser like BeautifulSoup),
- job scheduling / progress / persistence (`run_automation`, `_search_and_extract`, DB writes).

These belong in the Extractor EXE's Tauri shell / local service layer that this module
plugs into, built in the next slices of the EXE workstream.

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