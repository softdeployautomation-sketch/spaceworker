# Task 26 — Leads dashboard redesign, merge, email validator + upload, and a leads→mailer automation plan

**Status: Pieces 1–7 implemented. Piece 7's code + static verification landed 2026-09-12; two of its items (☆7d retention-sweep live test, ☆7f user re-confirmation) still need a live/user check to fully close — see the handoff section at the end of Piece 7.** Written 2026-09-12, based on directly reading the current `app/dashboard/extract/page.tsx` (897 lines), the current `Lead`/`SearchJob` Prisma models, and the standalone Lead Extractor's own proven validator (`app/lead_manager/validator.py`) and file-uploader (`app/lead_manager/uploader.py`) — Piece 3 below ports their actual logic, not a guess at what "validation" should mean. Piece 5 added 2026-09-12 after live user feedback on the mailboxes/campaigns UI. Piece 7 added 2026-09-12 after live user feedback on Pieces 1-4's actual deployed UI.

Pieces are independent and can be built/shipped in any order, but 1 is the fastest win and 3 is a prerequisite for 4's "extracted + validated" selection filter. Piece 5's two halves (5a mailbox testing, 5b rotation batch size) are also independent of everything else and of each other. Piece 7's sub-items are independent of each other too, but 7a (the stale validation-count bug) is the one genuine correctness bug in the list and should not wait behind the others.

---

## Piece 1 — Compact leads UI: hide the full query, auto-scroll to newest lead, activity log under the list, motion

### ✅ IMPLEMENTED (2026-09-12) — what changed & where, for the handoff

All Piece 1 changes landed in **`app/dashboard/extract/page.tsx` + `app/globals.css`**. Verified: `npx tsc --noEmit` exits 0, `npm run build` succeeds, and the built CSS contains both `.animate-\[fadeInUp_0.15s_ease-out\]{animation:.15s ease-out fadeInUp}` and `@keyframes fadeInUp{…}`.

- **1a (compact query)** — added module-level `summarizeQuery(job)` right after `isStalled(...)`. It reads `job.params.findTerms` / `job.params.locationTerms` (field names confirmed in the submit handler and `app/api/jobs/route.ts`) and falls back to `job.query.split(" | ")[0]` for pre-`findTerms` jobs. Both call sites now render `summarizeQuery(...)` with the **full raw query moved into a `title=` tooltip**: the job-list row (`{job.query}` → `{summarizeQuery(job)}`) and the detail-pane `<h2>`.
- **1b (activity log moved)** — removed the `Currently:` + stalled-warning block from the detail-pane header (under the `<h2>`); re-rendered the identical `selectedJob.status === "running"` block **below the leads table / empty-state**, still inside the `flex flex-col gap-4 p-4` container, right after the `})()}` that closes the table branch. The per-row caption in the job list was left untouched, as planned.
- **1c (auto-scroll)** — new component refs `leadsScrollRef`, `prevLeadCountRef`, `prevJobIdRef`, `userScrolledUpRef`. A `useEffect` (deps `[selectedJob?.id, selectedJob?.leads.length]`) scrolls to bottom **only when the lead count grows AND the user hasn't scrolled up**; it re-baselines when a different job is opened (so opening a finished job doesn't yank to the bottom) and clears the scrolled-up flag on job switch. `handleLeadsScroll` (wired via `onScroll` on the scroll container) sets `userScrolledUpRef` using a 40px bottom tolerance (~"back at the bottom"). The leads table was re-wrapped from `<div className="overflow-x-auto">` to a ref'd `<div ref={leadsScrollRef} onScroll={handleLeadsScroll} className="max-h-[50vh] overflow-x-auto overflow-y-auto">` so it has its own bounded vertical scroll area (nested inside the pane's 70vh outer scroll), letting `scrollTo` land on the newest row.
- **1d (motion, pure-CSS — no new dependency)** — added `@keyframes fadeInUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }` to `app/globals.css`, and put `animate-[fadeInUp_0.15s_ease-out]` on **every** leads-table `<tr>` unconditionally. That's not a mistake: a CSS animation only replays when the element is inserted or its animation value CHANGES, and the class string is constant across re-renders — so existing rows fade in once at mount while a genuinely-new row animates in when it's first added to the DOM. This avoids any per-row "am I new?" tracking (which this repo's strict `react-hooks/refs` + `set-state-in-effect` lint rules reject — refs can't be read during render, and setState can't run synchronously in an effect). The relocated `Currently:` `<p>` is `key`-ed on `currentStep` and carries the same animation class, so it crossfades when the step text changes instead of snapping.

**Handoff note for Piece 2:** the original line numbers cited below (669, 745, 754–765, 853–889, 891…) are all STALE — the ~120 lines of Piece 1 code (helper + refs + effects + restructured table) shifted everything down. Locate by **string search**, not line number: `summarizeQuery`, `leadsScrollRef`, `handleLeadsScroll`, and the relocated `Currently:` block. Also note this repo lints cleanly EXCEPT one pre-existing `react-hooks/set-state-in-effect` error on the untouched 4s-poll effect — don't "fix" it as part of Piece 2.

### The problems, confirmed by reading the current code

`app/dashboard/extract/page.tsx`:
- **Line 669** (job list row) and **line 745** (detail pane header) both render `{job.query}` / `{selectedJob.query}` — this is the full pipe-joined string of every Find×Location combination (e.g. `"sbcglobal.net in usa | sbcglobal.net in usa 2025_2026 | ... "` — literally hundreds of characters for a real multi-term job). Line 669 is already `truncate`d in a flex row, but the truncation still reserves the row's whole width and reads as visual noise the user explicitly doesn't want to see at all.
- **Activity log placement**: line 729-733 (list row) and line 754-765 (detail pane) both render the live `currentStep` text **above** the leads table, as a small caption near the header. The user wants it **under the emails list** instead, paired with auto-scroll, so the newest lead and the step that just found it are visible together without scrolling.
- **No auto-scroll at all today**: the leads table (line 854-889) is a plain `<table>` inside an `overflow-y-auto` div (line 738) with no ref, no scroll-to-bottom effect, and no `key`-based mount/animation on new rows. A running job's newly-arrived leads land at the bottom of a table the user has to manually scroll to see.
- **No entrance animation** on new rows or on the activity-log line updating — both currently just snap-update on each poll tick.

### The fix

**1a. Replace the full query with a compact summary.** Every job's `params` already stores `findTerms`/`locationTerms` (confirmed in `app/api/jobs/route.ts`) for exactly this purpose — reconstructing what the user actually typed, not the cross-multiplied result. Add a small helper:

```tsx
function summarizeQuery(job: Pick<Job, "query" | "params">): string {
  const findTerms = Array.isArray(job.params?.findTerms) ? job.params.findTerms as string[] : null;
  const locationTerms = Array.isArray(job.params?.locationTerms) ? job.params.locationTerms as string[] : null;
  if (findTerms && findTerms.length > 0) {
    const findLabel = findTerms.length === 1 ? findTerms[0] : `${findTerms[0]} +${findTerms.length - 1}`;
    if (locationTerms && locationTerms.length > 0) {
      const locLabel = locationTerms.length === 1 ? locationTerms[0] : `${locationTerms.length} locations`;
      return `${findLabel} in ${locLabel}`;
    }
    return findLabel;
  }
  // Pre-findTerms jobs (created before that field existed) or single-query jobs —
  // fall back to the first pipe-segment of the raw query, still truncated.
  return job.query.split(" | ")[0];
}
```

Use `summarizeQuery(job)` in place of `{job.query}` at line 669 and `summarizeQuery(selectedJob)` in place of `{selectedJob.query}` at line 745. Keep the **full** query string available as a `title=` tooltip on both (hover to see everything) — don't destroy the information, just stop it from consuming layout space by default.

**1b. Move the activity-log line under the leads table, not above it.** Remove the block at lines 754-765 (the "Currently: …" + stalled-warning paragraph in the detail-pane header) and re-render the same content **below** the leads table/empty-state (after line 891's closing `})()}`, still inside the `<div className="flex flex-col gap-4 p-4">` from line 742) — same conditions (`selectedJob.status === "running"`), same stalled-check, same text. The per-row version in the job list (lines 729-733) can stay where it is — that one is a compact list-row caption, not the "under the emails" placement the ask is about; only the **detail pane's** placement moves.

**1c. Auto-scroll the leads table to the newest lead.** Add a ref to the table's scroll container and an effect that scrolls to bottom whenever `selectedJob.leads.length` grows:

```tsx
const leadsScrollRef = useRef<HTMLDivElement | null>(null);
const prevLeadCountRef = useRef(0);

useEffect(() => {
  const count = selectedJob?.leads.length ?? 0;
  if (count > prevLeadCountRef.current && leadsScrollRef.current) {
    leadsScrollRef.current.scrollTo({ top: leadsScrollRef.current.scrollHeight, behavior: "smooth" });
  }
  prevLeadCountRef.current = count;
}, [selectedJob?.leads.length]);
```

Wrap the `<table>` (currently just inside `<div className="overflow-x-auto">` at line 853) in this ref'd container — give IT the `overflow-y-auto` + a bounded height (e.g. `max-h-[50vh]`) since the table needs its OWN scroll area to scroll-to-bottom within, independent of the detail pane's own outer scroll (line 738's `max-h-[70vh] overflow-y-auto` on the whole pane). Nest: outer pane scrolls the whole pane (header + table + activity log) into view as a unit; the inner leads-table container gets the auto-scroll-to-newest behavior specifically. Only auto-scroll when the count *increases* (not on every poll tick) so a user who's manually scrolled up to review earlier leads doesn't get yanked back down by an unrelated re-render — track this via a `userScrolledUp` boolean set by an `onScroll` handler (if `scrollTop + clientHeight < scrollHeight - 40`, treat as "user is reading history," skip the auto-scroll until they return to the bottom themselves).

**1d. Motion/animation pass.** This app already has zero animation library (confirmed: no framer-motion, no equivalent in `package.json`). Two options, pick whichever Cline finds cleaner to wire up:
- Add `framer-motion` (small, well-supported, works fine with Next.js client components) and wrap each `<tr>` in an `AnimatePresence`+`motion.tr` with a short fade+slide-in (`initial={{opacity:0, y:8}} animate={{opacity:1, y:0}}`, ~150ms) keyed by `lead.id` so new rows animate in distinctly from ones already present.
- Or, if avoiding a new dependency is preferred, a pure-CSS `@keyframes fadeInUp` applied via a Tailwind arbitrary-animation class on new rows, tracked by comparing the previous render's lead-id set to the current one (only apply the animation class to genuinely-new ids, not every row on every render).

Either way: the activity-log line's text change (as `currentStep` updates) should also get a brief crossfade rather than an instant snap — a `key={currentStep}` on the text node combined with the same animation approach is enough; don't build a separate transition system for it.

---

## Piece 2 — Merge leads

### ✅ IMPLEMENTED (2026-09-12) — what changed & where, for the handoff

All Piece 2 changes landed in **`app/api/leads/merge/route.ts`** (new) + **`app/dashboard/extract/page.tsx`**. Verified: `npx tsc --noEmit` exits 0, `npm run build` succeeds (new route registered as `/api/leads/merge`), and `npx eslint` on both files is clean EXCEPT the same single pre-existing `react-hooks/set-state-in-effect` error on the untouched 4s-poll effect in `page.tsx` (still NOT to be "fixed" in this pass).

- **API route `app/api/leads/merge/route.ts`** — `POST { leadIds: string[] (>=2), merged: { email, phone, contactName, businessName, website, sourceUrl?, snippet? } }`. Auth-gated via the standard `getSession()` → 401. Loads all source leads in one `findMany`, then: any missing/non-owned id → **404** (the app's "don't leak existence" convention), any mixed-`searchJobId` → **400** with a clear "come from different jobs and can't be merged" message. Runs a `prisma.$transaction(async tx => …)` that **`deleteMany`s the source rows FIRST, then `create`s the merged row** (delete-before-create is deliberate: the `@@unique([searchJobId, sourceUrl, email])` constraint from Task 25 means the merged email, usually one of the sources' OWN, would collide with that same source row if we created first). Wraps everything in a try/catch mapping a Postgres `P2002` to a friendly 409 "A lead with this email already exists in this job…" instead of a raw 500. Returns the new lead.
- **`page.tsx` UI** — new checkbox column (leftmost `<th>` + per-`<tr>` checkbox) backed by a `Set<string>` `selectedIds` state (`toggleSelected` writer, `Set<string>()` explicit-typed). A sticky-to-pane action bar (`sticky bottom-0 z-10 …`) appears only when **2+** are selected, showing "N leads selected · Merge N leads". Clicking opens a `createPortal` modal (to `document.body`, same fix as the campaigns/mailboxes modals) that lists the selected sources read-only and shows the 5 editable merge fields (email/business/contact/phone/website) **pre-filled from the FIRST non-empty value across the selected leads** (`openMergeModal`). `confirmMerge` POSTs, closes the modal + clears the selection on success, and re-fetches the job detail + job list so the single new row replaces the merged-away ones.
- Selection is cleared on job switch (in the job-list row's onClick) so a new job doesn't inherit a stale selection.

**Handoff note for Piece 3:** the original line numbers in this doc are STALE again — Piece 1's ~120 lines and Piece 2's ~90 more shifted `page.tsx` considerably (it's now ~1170 lines). There is NO `components/modal.tsx` in this repo; the modal pattern is an inline `createPortal` (see `app/dashboard/campaigns/page.tsx` line ~259 and `app/dashboard/mailboxes/page.tsx` line ~328), which is what Piece 2 reused. Locate by **string search**, not line number: `toggleSelected`, `openMergeModal`, `confirmMerge`, `selectedIds`, `/api/leads/merge`. The pre-existing `set-state-in-effect` error on the 4s-poll effect remains and should stay untouched.

### The feature

Let a user select 2+ leads (e.g. near-duplicates surfaced by different documents/queries) and combine them into a single lead, choosing which field values to keep.

### Data model — no new table needed

Reuse `Lead` as-is. A merge operation: create ONE new `Lead` row with the chosen field values, then delete the N source rows. No new Prisma model required.

### API

New route `app/api/leads/merge/route.ts`:

```ts
POST { leadIds: string[] (>= 2), merged: { email, phone, contactName, businessName, website, sourceUrl?, snippet? } }
```
- Auth-gate (session required, same pattern as every other route in this app).
- Load all `leadIds`, verify EVERY one belongs to `session.userId` (404, not 403, if any don't — same "don't leak existence" convention already used elsewhere in this app) and that they all belong to the SAME `searchJobId` (merging leads across two different jobs isn't a supported case for v1 — reject with a clear error if the caller tries).
- In a `prisma.$transaction`: create the new merged `Lead` (attached to that shared `searchJobId`), then `deleteMany` the original `leadIds`.
- **The unique constraint** (`@@unique([searchJobId, sourceUrl, email])`, see the schema — already fixed this session, Task 25) means the merged row's `(sourceUrl, email)` pair must not collide with a DIFFERENT lead still remaining in that job. In practice this is very unlikely (the merge input's email is usually one of the source leads' own emails, and that source row is being deleted in the same transaction) but wrap the create in a try/catch for Postgres unique-violation (`P2002`) and surface a friendly "a lead with this email already exists in this job" error rather than a raw 500.
- Return the new lead.

### UI (`app/dashboard/extract/page.tsx`)

- Add a checkbox column to the leads table (leftmost, before Business/Name/Email/etc.) — a `Set<string>` of selected lead ids in component state.
- When 2+ are selected, show a small floating action bar (fixed near the bottom of the leads pane, not the whole page) — "Merge N leads" button.
- Clicking it opens a `Modal` (reuse `components/modal.tsx`) showing the selected leads side by side, with the merge form pre-filled from the FIRST non-empty value found across the selected leads for each field (email/phone/contactName/businessName/website) — editable before confirming, so the user can pick a different source's value per field if the auto-pick guessed wrong. Confirm calls the new API route, then removes the merged rows and adds the new one to local state (or just re-fetches the job detail — simpler, acceptable given merges are an occasional manual action, not a hot path).

---

## Piece 3 — Email validator + drag-and-drop upload

### ✅ IMPLEMENTED (2026-09-12) — what changed & where, for the handoff

All Piece 3 changes landed as: one Prisma migration, two new `lib/` modules, two new API routes, two edits to existing routes, and the extract page UI. Verified: `npx tsc --noEmit` exits 0, `npm run build` succeeds with the new routes registered (`ƒ /api/jobs/[id]/validate`, `ƒ /api/leads/upload`), eslint on every new/changed file is clean apart from the documented pre-existing error, and the parser was exercised directly via `tsx`.

- **Migration** — `prisma/migrations/20260912020000_add_lead_validation/migration.sql` adds three `Lead` columns: `validationStatus TEXT NOT NULL DEFAULT 'unchecked'` (`"unchecked" | "valid" | "invalid"`), `validationError TEXT` (reason string, only set when invalid), `validatedAt TIMESTAMP(3)`. Applied via `prisma migrate deploy` (the local DB user lacks shadow-db CREATE privileges, so `migrate dev` fails with P3014 — use `migrate deploy`), then `prisma generate`.
- **`lib/email-validator.ts` (new)** — ports `validator.py`'s exact two-step approach: RFC-ish syntax regex (the plan's `EMAIL_RE`) then `node:dns/promises` MX lookup, cached per-domain, exposed as `validateEmail` + `validateEmailsBatch(emails, concurrency=20)`. Deliberately NOT SMTP.
- **`lib/lead-file-parser.ts` (new)** — ports `uploader.py`'s parse/normalize logic with the same permissive import (no-email rows dropped, everything else kept). ONE deliberate deviation from the plan: **CSV/TSV reuse `lib/csv.ts`'s existing `parseCsv` instead of adding `papaparse`** — this repo's own header comment says it deliberately avoids a CSV dependency. JSON = `JSON.parse`, plain text = one email per line, and `.xlsx`/`.xls` use the `xlsx` (SheetJS) package I added (the only new dependency).
- **`app/api/jobs/[id]/validate/route.ts` (new)** — `POST`, auth-gated, 404-on-foreign-job (don't-leak-existence). Loads the job's `validationStatus: "unchecked"` leads that have an email, runs `validateEmailsBatch`, writes results in one transaction (bullet `updateMany` for valid + per-row for invalid so each keeps ITS reason). Returns `{ valid, invalid, validated, skipped }`. No-email leads are left "unchecked".
- **`app/api/leads/upload/route.ts` (new)** — `POST` multipart, one `file` field (via `req.formData()`, Node-native), 20MB cap, parses with `lib/lead-file-parser.ts`, rejects if 0 usable rows. Creates a `SearchJob` (`template: "upload"`, `status: "done"`, `lane: "light"`, `workerJobId: null`, `query: "Uploaded: <filename>"`, `params: { template:"upload", fileName, originalRowCount }`) + `createMany` the `Lead` rows with `skipDuplicates: true` in one transaction. Returns `{ jobId, imported, requested, format, messages }`. Imported batches show up in the SAME job list and reuse the SAME leads table (validate / merge / export / status pill) with zero extra UI.
- **`app/api/jobs/route.ts`** — `TEMPLATES` now includes `"upload"`, but `POST /api/jobs` explicitly rejects `template === "upload"` (uploads are only ever created via `/api/leads/upload`).
- **`app/api/jobs/[id]/route.ts`** — `GET` now selects `validationStatus`/`validationError`/`validatedAt` so the page's re-fetch after "Validate all" surfaces the new pills.
- **`app/dashboard/extract/page.tsx`** — (a) an **"Import leads"** header button opening a drag-and-drop upload modal (a `createPortal`-to-`document.body` dialog gated on `uploadOpen`, matching the page's existing inline-portal pattern); on success closes, refreshes the list, and jumps to the new job; (b) a **"Validate all"** button next to Export CSV (disabled while busy / when nothing is unchecked); (c) a new **Status** column rendering a `Badge` pill (green "Valid" / red "Invalid" with a `title` carrying the reason / grey "—" for unchecked).

**Handoff notes for Piece 4 (leads→mailer) and whoever picks up 5/6:**
- `page.tsx` line numbers shift after every edit — locate by **string search**, never line number.
- The pre-existing `react-hooks/set-state-in-effect` eslint error in the 4s poll effect (top `void fetchJobs()` in the mount `useEffect`) is on committed `HEAD` and **must stay untouched**.
- New dependency: `xlsx` only. CSV/TSV intentionally reuse `lib/csv.ts` — do not "add papaparse" to match the plan text; the codebase deliberately avoids a CSV dependency.
- `components/modal.tsx` DOES exist (the Piece 2 handoff was mistaken that it didn't). Keep new dialogs on this page in the existing inline `createPortal` style — don't refactor merge/upload modals to `Modal` as part of another piece.
- Piece 4's "Pick from my leads" picker should filter on `validationStatus === "valid"` **server-side** in the new recipients route (never trust the client filter). Because uploaded batches are `SearchJob template:"upload"`, the plan's "filter by source job" dropdown naturally covers both extracted and uploaded leads. Merged leads (Piece 2) come back as `validationStatus: "unchecked"` (the merge route's `create` uses the column default), so re-validate before they're picker-eligible — expected, not a bug.

### Validator logic — ported from the standalone's proven, real implementation

Confirmed by reading `app/lead_manager/validator.py` directly: it does NOT do SMTP-handshake verification (slow, unreliable, often blocked by mail servers) — it does exactly two cheap, fast, reliable checks:
1. **Syntax/format** — RFC-compliant parsing (the standalone uses Python's `email_validator` package with `check_deliverability=False`).
2. **DNS MX record lookup** — confirms the domain actually has a mail server configured, cached per-domain in-process so repeated domains (common in a batch) are instant after the first lookup.

Port this exact two-step approach to Node/TypeScript, not something more elaborate:

New file `lib/email-validator.ts`:
```ts
import "server-only";
import dns from "node:dns/promises";

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const mxCache = new Map<string, boolean>();

export interface ValidationResult {
  email: string;
  isValid: boolean;
  reason?: "invalid_format" | "no_mx_records" | "dns_error";
}

async function domainHasMx(domain: string): Promise<boolean> {
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  try {
    const records = await dns.resolveMx(domain);
    const ok = records.length > 0;
    mxCache.set(domain, ok);
    return ok;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

export async function validateEmail(rawEmail: string): Promise<ValidationResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { email, isValid: false, reason: "invalid_format" };
  }
  const domain = email.split("@")[1];
  const hasMx = await domainHasMx(domain);
  return hasMx ? { email, isValid: true } : { email, isValid: false, reason: "no_mx_records" };
}

// Batch helper — validates many emails with bounded concurrency so a large
// upload doesn't fire hundreds of simultaneous DNS lookups at once. The
// per-domain cache above means a batch dominated by a few common domains
// (gmail.com, yahoo.com, ...) is fast regardless of batch size.
export async function validateEmailsBatch(emails: string[], concurrency = 20): Promise<ValidationResult[]> {
  const results: ValidationResult[] = new Array(emails.length);
  let index = 0;
  async function worker() {
    while (index < emails.length) {
      const i = index++;
      results[i] = await validateEmail(emails[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, worker));
  return results;
}
```

### Data model addition

```prisma
model Lead {
  // ...existing fields unchanged...
  validationStatus String  @default("unchecked") // "unchecked" | "valid" | "invalid"
  validationError  String? // e.g. "invalid_format" | "no_mx_records" — set only when invalid
  validatedAt      DateTime?
}
```
Migration additive, safe against existing rows (new columns default/nullable).

### "Validate" actions

- **Validate existing leads**: new route `app/api/jobs/[id]/validate/route.ts`, `POST` — loads all `Lead` rows for that job with `validationStatus: "unchecked"`, runs `validateEmailsBatch` on their emails, `updateMany`/individual updates writing `validationStatus`/`validationError`/`validatedAt`. Add a "Validate all" button in the leads pane (near Export CSV) that calls this and shows a small progress/result toast ("142 valid, 8 invalid").
- **Validation status column**: add a column to the leads table (a small `Badge`-style pill: green "Valid" / red "Invalid" / grey "—" for unchecked) — reuse whatever badge component convention this app already has (check `components/ui.tsx` for an existing `Badge`, mirror its styling if present; add one modeled on it if not).

### Upload tool — the "fancy drag-and-drop toolbox"

**Parsing logic — ported from the standalone's proven, permissive approach** (`app/lead_manager/uploader.py`): accepts `.txt` (one email per line), `.csv`/`.tsv` (header-based column mapping, case-insensitive, with a wide list of recognized header name variants per field — `email`/`e-mail`/`mail`/`email_address`/... for email, similar lists for business name/contact name/phone/website), `.json` (array of objects, or an object with a `leads`/`items`/`records`/`data` array key), and `.xlsx` (first sheet, header row + data rows). Import is deliberately permissive — rows with no recognizable email are dropped, everything else is kept as-is; validation is a **separate**, explicit step the user triggers after import, never automatic at upload time (matches the standalone's own stated design).

New file `lib/lead-file-parser.ts` — port `parse_text_file`/`parse_csv_file`/`parse_json_file`/`normalize_lead` from the Python source above field-for-field (same header-alias lists, same single-column-fallback behavior). Use `papaparse` for CSV/TSV parsing and `xlsx` (SheetJS) for `.xlsx` — both are standard, well-supported npm packages for this; add them as dependencies.

**Data model for an upload**: reuse `SearchJob` + `Lead` rather than inventing a parallel table — an upload becomes a `SearchJob` with `template: "upload"` (extending the existing `"lead" | "hr" | "plain"` union — confirmed in `app/api/jobs/route.ts`'s `TEMPLATES` tuple, add `"upload"` there too, but this route should REJECT `template: "upload"` if submitted through the normal job-creation endpoint — uploads only ever get created via the new upload route below, never through `POST /api/jobs`), `status: "done"` (an upload has nothing to "run" — it's immediately complete), `lane: "light"` (unused placeholder, no worker job ever claims it), `workerJobId: null`, `query` set to the original filename (e.g. `"Uploaded: contacts.csv"`), `params: { template: "upload", fileName, originalRowCount }`. This means an uploaded batch shows up in the SAME job list, reuses the SAME leads-table UI (including the new validate/merge features above) with zero extra UI work — it just looks like a job that's already "done."

New route `app/api/leads/upload/route.ts`, `POST` (multipart/form-data, one file field): parse via `lib/lead-file-parser.ts`, reject if >20MB or 0 usable rows found, create the `SearchJob` + `Lead` rows (`createMany`, `skipDuplicates: true` — same convention as the dispatcher) in one transaction, return the new job id so the UI can navigate straight to it.

**The "fancy drag-and-drop" UI**: new component `components/lead-upload-dropzone.tsx` — a bordered dashed-outline drop target (drag-over state highlights the border + shows a subtle scale/glow via a CSS transition, not a new animation library dependency for this one piece — Piece 1's framer-motion, if added there, can be reused here too for consistency), accepting the same file types listed above, with a file-type icon + filename + size shown once a file is chosen (before upload), a clear "supports .csv, .txt, .xlsx, .json" hint text, and upload progress feedback. Place this as a new panel/tab in `app/dashboard/extract/page.tsx` (a toggle between "New search" and "Upload leads," or a separate small card above/beside the existing search form — Cline's call on exact placement, but it should be reachable from the same page, not a separate route, since it's part of the same "get leads into the system" surface).

---

## Piece 4 — Plan (+ first slice) for automating leads → mailer

### ✅ IMPLEMENTED (2026-09-12) — what changed & where, for the handoff

Landing exactly the "Pick from my leads" flow. The existing "Upload a CSV" path and the legacy `?fromSearchJob` deep-link are untouched; the new picker is an ADDITIONAL recipient source scoped to **`validationStatus: "valid"`** (never unchecked/invalid). Verified: `npx tsc --noEmit` exits 0, `npm run build` succeeds with both new routes registered (`ƒ /api/campaigns/[id]/recipients/from-leads`, `ƒ /api/leads/selectable`), eslint is clean on every new/changed line (the only findings left in the campaigns page are PRE-EXISTING at HEAD: the two `react-hooks/set-state-in-effect` on `load()`/`setLeadCountError("")` in effects, an unused `exhaustive-deps` disable, and one unescaped `You'll` in the modal subtitle — all left alone, consistent with the Piece 3 handoff note), and the shared round-robin helper was exercised directly via `tsx`.

- **`lib/campaign-recipients.ts` (new)** — the single source of truth for recipient → `EmailQueueItem` assignment. `buildQueueItemRows({ campaignId, mailboxIds, variantRows, recipients })` applies `mailboxId: mailboxIds[i % len]` and `variantId: variantRows[i % len]` (the SAME round-robin the CSV/create path always used) and `leadToRecipient(lead)` builds the merge-variable object (`businessName`/`contactName`/`phone`/`website`, non-empty only, email trimmed but casing preserved — mirrors `lib/csv.ts`'s `parseRecipientsCsv`). The round-robin lives here precisely so the create path and the from-leads route can never drift.
- **`app/api/leads/selectable/route.ts` (new, GET, auth)** — one round trip that feeds the whole picker: `jobs` = the user's SearchJobs with `totalCount` (via `_count`) and `validCount` (via a `groupBy` on `validationStatus: "valid"`), plus `leads` = **all** of the user's valid leads (`id/email/businessName/contactName/searchJobId`) so "select all valid across everything" needs no second call.
- **`app/api/campaigns/[id]/recipients/from-leads/route.ts` (new, POST `{ leadIds }`, auth)** — the AI-automatable "add to existing campaign" primitive. Server-side re-checks campaign ownership (404 on foreign, no existence leak) and `validationStatus: "valid"` on every requested lead; excludes blank emails; dedups within the request and against the campaign's existing items (no double-queuing); assigns mailbox/variant via `buildQueueItemRows`. Returns `{ added, skipped, skippedDuplicates, requested }`. Deliberately **does not** trust the client's filter — a hand-crafted `leadIds` list can't smuggle in an invalid/unchecked/foreign address (they're silently excluded and the counts make that visible).
- **`app/api/campaigns/route.ts` `POST` (edited)** — accepts `leadIds: string[]` as a third recipient source (CSV > leadIds > `searchJobId` precedence, preserving the original "parsed wins" rule). Same server-side valid/owned re-check; creates the campaign + variants + queue items in ONE transaction using the shared helper. The legacy `searchJobId` branch is left deliberately un-restricted (still sends every email-bearing lead) so the `?fromSearchJob` deep-link keeps its old behavior — the validation gate is only on the new source, which is the whole point of Piece 4.
- **`app/dashboard/campaigns/page.tsx` (create modal)** — a segmented toggle "Upload a CSV / Pick from my leads" (hidden in the locked `?fromSearchJob` mode). The leads picker shows a source-job dropdown (each job labeled with its valid count; upload jobs show " (upload)" so extracted and imported leads are both covered, exactly as Piece 3's design intended), a free-text search across email/business name, "Select all visible" / "Clear visible" / "Select all valid across everything" shortcuts, and a running "N recipients selected" count, over a checkbox-per-row scrolled list. Submit posts `{ leadIds }`; lazy-loads `/api/leads/selectable` on first toggle and caches the payload for the session.

**Handoff notes for the next agent (Piece 5):**
- The plan text below (lines ~238–271) is now fully implemented — treat "### The plan" as historical specs, not work to do.
- If a later piece wants "add recipients to an existing draft campaign," the `[id]/recipients/from-leads` route already exists; only a UI entry point would need adding (the create modal is wired to the one-shot `POST /api/campaigns { leadIds }` instead, to keep create atomic).
- The `skipped` count in from-leads only reflects rows dropped by `createMany` (currently always 0); `skippedDuplicates` is the "already in this campaign" tally.
- `app/dashboard/mailboxes/page.tsx` and `app/globals.css` still show uncommitted pre-existing changes — leave them as-is (Pieces 5/6 context).

### The design question this answers

Once leads exist (extracted, or uploaded+validated), how does a user get them INTO a campaign's recipient list (the existing `EmailCampaign`/mailbox-rotation system built earlier — see `app/dashboard/campaigns/`) without manually re-typing/re-exporting a CSV?

### Confirmed current state — read directly from the schema, not guessed

A campaign's recipients are `EmailQueueItem` rows (NOT a separate "recipients" table with a different name):
```prisma
model EmailQueueItem {
  id         String   @id @default(cuid())
  campaignId String
  mailboxId  String   // assigned at queue-creation time via round-robin across mailboxIds
  variantId  String?  // which subject/body this recipient resolved to
  toEmail    String
  variables  Json?    // per-recipient merge vars from the uploaded CSV's extra columns — { "firstName": "Ada", "company": "ACME", ... }
  status     String   @default("queued")
}
```
Today, `variables` is populated from a CSV upload's non-email columns (confirmed by the field's own comment). `EmailCampaign` also already has an OPTIONAL `searchJobId String?` — a single job reference, likely from an earlier/simpler version of this idea — Piece 4 below supersedes that single-job link with the richer multi-job, multi-source picker; leave the column in place (don't drop it, no migration needed) but the new picker does not read from it.

### The plan

1. **Selection source, exactly as asked**: when creating a campaign (or adding recipients to an existing draft one), offer a choice — "Upload a CSV" (existing, unchanged — still writes `EmailQueueItem` rows the same way it does today) or **"Pick from my leads"** (new). The second option opens a picker scoped to `Lead` rows where `validationStatus: "valid"` (never send to unchecked or invalid addresses by default — this is the whole point of having validation), filterable by source job (a dropdown of the user's recent extraction/upload jobs — remember Piece 3 means an uploaded batch is ALSO a job, so this one dropdown naturally covers both extracted and uploaded leads) and by a free-text search across email/business name.
2. **Selection UI**: a checkbox-per-row list (reuse the same selection-state pattern as Piece 2's merge checkboxes) with "select all valid in this job" / "select all valid across everything" shortcuts, and a running count ("214 recipients selected").
3. **Wiring into the campaign**: new route `app/api/campaigns/[id]/recipients/from-leads/route.ts`, `POST { leadIds: string[] }` — validates ownership + `validationStatus: "valid"` server-side too (never trust the client's filter alone), then for each selected `Lead` creates an `EmailQueueItem` with `toEmail: lead.email`, `variables: { businessName: lead.businessName, contactName: lead.contactName, phone: lead.phone, website: lead.website }` (so a template's merge-fields work identically whether a recipient came from a CSV column or a Lead field), `mailboxId` assigned via the SAME round-robin logic the CSV-upload path already uses (find and reuse that existing function/code path rather than re-deriving it — check wherever the CSV-upload route currently assigns `mailboxId` and call the same helper). `variantId` stays null at creation, exactly like the CSV path presumably does (confirm by reading that route), assigned later at send/drain time.
4. **Explicitly deferred, not part of this pass**: any FULLY automatic pipeline (e.g. "every new valid lead automatically joins campaign X with no human step") — the ask was for a way to *select* which leads go to the mailer, not an unattended auto-enroll. If real demand for that shows up later, it's a bounded follow-up (a per-job or per-user "auto-add valid leads to campaign X" toggle), not something to build speculatively now.

### Verification (Piece 4)

1. Extract a real small batch, validate it, confirm only "valid" ones are selectable in the campaign picker.
2. Upload a CSV, validate it, confirm uploaded+validated leads are selectable exactly the same way extracted ones are (proving the "reuse SearchJob+Lead" design in Piece 3 actually pays off here).
3. Confirm an invalid or unchecked lead is never selectable/sendable through this path, even if the user tries to force it via a direct API call with a hand-crafted leadId list.

---

## Piece 5 — Mailbox connection testing + security options, and campaign rotation batch size

### Context: a real bug already fixed, and two real UX gaps found alongside it

While setting up a real mailbox for live testing, a genuine bug surfaced and was fixed directly (not part of this piece's remaining work, documented here for continuity): `lib/mailer-send.ts`'s `transporterForMailbox` and the mailbox "Test" route both passed the stored `secure` checkbox value straight into nodemailer's `secure` option, which means *implicit* TLS — correct only for port 465. A real Brevo SMTP relay account on port 587 (STARTTLS, like Gmail and most providers) failed with `SSL routines:tls_validate_record_header:wrong version number` — the classic "sent a TLS handshake to a server expecting plaintext-first" symptom. **Already fixed and deployed**: `secure` is now derived from the port (`port === 465`), with `requireTLS: true` otherwise, and the "Test" route now calls the shared `transporterForMailbox` instead of duplicating its own (buggy) transport construction. Piece 5 is the two follow-on UX gaps the user asked for while hitting that bug:

### 5a. Test a mailbox's connection BEFORE saving it, and expose real security options

**Confirmed current state**: `components/add-device-modal.tsx` doesn't exist in this repo (that's a Vantra component name — this app's actual file is the inline form in `app/dashboard/mailboxes/page.tsx`, lines ~327+ per Piece 1's own handoff notes, already using a `createPortal` modal). The form collects Label/Host/Port/Daily limit/Username/From address/Password/"Use TLS" checkbox, then POSTs straight to `POST /api/mailboxes` (create) with no verification step — a wrong host/port/password/security combo is only discovered AFTER saving, via the existing post-save "Test" button on the mailbox card.

**The fix**:
1. New route `app/api/mailboxes/test-connection/route.ts`, `POST { host, port, secure, username, password }` (all raw, unsaved values — nothing in the DB yet). Auth-gated (session required, same as every route). Builds a transport with the SAME corrected logic as `transporterForMailbox` (derive `secure`/`requireTLS` from `port === 465`, not from a client-sent boolean — a client could still send a `secure` flag for the UI's own display purposes, but the SERVER must decide the actual negotiation style from the port, matching the already-fixed real transporter and preventing this exact bug from being reintroduced through a second code path). Calls `transport.verify()`, returns `{ ok, error }` — same shape as the existing post-save test route. **Never persists anything** — this is a pure connectivity check on values still sitting in the open form.
2. In the Add Mailbox form: add a "Test connection" button (secondary/outline style, matching the existing Cancel/Add button row) that POSTs the CURRENT form field values to this new route and shows the same inline result UI the mailbox card already uses for its post-save test (a green check + "Connected" or a red X + the error message) — reuse that exact presentation, don't invent a second one. Enabled once Host/Port/Username/Password are all non-empty; disabled with a tooltip otherwise. This does not block "Add mailbox" — a user can still save without testing first (the post-save test button already covers that case), it just lets them catch a bad config immediately instead of after saving.
3. **Security options, replacing the single ambiguous "Use TLS" checkbox**: since the bug above was fundamentally "one checkbox conflating two independent things (encrypt at all vs. which handshake style)," replace it with a small `Select` offering the three real-world options a user actually needs, each pre-filling the Port field with the conventional default (editable after, in case a provider is nonstandard):
   - **"STARTTLS (recommended — port 587)"** → sets port to 587 if empty, stores `secure: false` (still always encrypted via `requireTLS` server-side, per the fix above — this label is about *when* the encryption kicks in, not whether it happens)
   - **"Implicit TLS / SSL (port 465)"** → sets port to 465 if empty, stores `secure: true`
   - **"None (port 25, unencrypted — not recommended)"** → sets port to 25 if empty, stores `secure: false`, `requireTLS: false` (needs a corresponding non-forcing branch server-side: only force `requireTLS` when NOT explicitly "none" — thread a genuine `allowInsecure` flag through `transporterForMailbox`/the Mailbox model rather than inferring "no TLS wanted" purely from port 25, since port 25 relays sometimes DO support STARTTLS). Show a small inline warning icon/text next to this option — real providers essentially never require this, it exists for self-hosted/internal relays only.
   Store the resolved `secure` (and new `allowInsecure` boolean, default `false`) on the `Mailbox` row exactly as today — no schema rename needed, `secure` already exists; add one migration for `allowInsecure Boolean @default(false)` and thread it through `transporterForMailbox`'s TLS-decision (`requireTLS: !implicitTls && !mailbox.allowInsecure`).

### 5b. Campaign rotation batch size — "how many emails before it rotates subject/mailbox"

**Confirmed current state**: `app/api/campaigns/route.ts`'s queue-creation loop (~line 184-185) assigns `mailboxId: mailboxIds[i % mailboxIds.length]` and `variantId: variantRows[i % variantRows.length].id` — this rotates on EVERY recipient (`i`), i.e. batch size is hardcoded to 1. There is no field anywhere (request body, `EmailCampaign` model) controlling this.

**The fix**:
1. Schema: add `rotateEvery Int @default(1)` to `EmailCampaign` (migration additive, safe default preserves today's exact behavior for existing/未-updated campaigns).
2. `app/api/campaigns/route.ts`'s `POST` body gains `rotateEvery?: number`, clamped `Math.max(1, Math.min(1000, Math.floor(...)))` (defensive bound — no realistic campaign needs more than 1000 emails between rotations, matching the general "clamp everything server-side" convention already used throughout this app, e.g. `maxResults`/`minResults` in `app/api/jobs/route.ts`). Store on the created `EmailCampaign` row.
3. The rotation formula changes from `i % mailboxIds.length` / `i % variantRows.length` to `Math.floor(i / rotateEvery) % mailboxIds.length` / `Math.floor(i / rotateEvery) % variantRows.length` — recipients `0..rotateEvery-1` all get the first mailbox/variant, the next `rotateEvery` get the second, etc., wrapping around. `rotateEvery: 1` (the default) reproduces today's exact per-recipient rotation, so this is non-breaking for anyone not using the new field.
4. UI (`app/dashboard/campaigns/page.tsx`'s "New campaign" form): add a labeled number input "Rotate every N emails" (default value 1, min 1) near the existing Sending mailboxes / Subject lines fields — short helper text: "Send N emails from one mailbox/subject before moving to the next." Wire into the existing campaign-creation POST body.

### ✅ IMPLEMENTED (2026-09-12) — Piece 5 (both halves), what changed & where, for the handoff

**New backend**
- `app/api/mailboxes/test-connection/route.ts` (POST, auth) — pre-save mailbox connectivity/auth test on the form's CURRENT values; builds a transport through the shared `buildSmtpTransport`, calls `verify()`, returns `{ ok: true }` or `{ ok: false, error }`. **Never persists** — no row, no `MAILBOX_SAFE_SELECT`, no password stored. Sends no mail, so it's offered in both Add and Edit.
- `lib/mailer-send.ts` — extracted `buildSmtpTransport(opts)` (single source of truth for port-derived `secure: port === 465` + `requireTLS: !implicitTls && !allowInsecure`) and `transporterForMailbox` now delegates to it, now passing `allowInsecure`. The pre-save test and every real send share byte-identical TLS logic, so "test OK" means the stored mailbox will connect the same way.

**Edited (5a — mailboxes)**
- `prisma/schema.prisma` + migration `prisma/migrations/20260912030000_add_mailbox_allow_insecure_and_campaign_rotate_every/` — added `Mailbox.allowInsecure Boolean @default(false)` and `EmailCampaign.rotateEvery Int @default(1)` (applied to the local DB via `prisma migrate deploy`).
- `app/api/mailboxes/route.ts` `POST` — now derives `secure = port === 465` (never a checkbox) and stores `allowInsecure`.
- `app/api/mailboxes/[id]/route.ts` `PUT` — same derivation when port/security changes; stores `allowInsecure`.
- `lib/mailbox-safe-select.ts` — exposes `allowInsecure` (not the password columns).
- `app/dashboard/mailboxes/page.tsx` — replaced the single "Use TLS" checkbox with a Security `<select>` (STARTTLS/port 587 recommended, Implicit TLS/port 465, None/port 25 unencrypted, each pre-filling the Port field, still editable), a "⚠" warning under the None option, and a **"Test connection"** button that POSTs the current form to the new route and shows a green/red inline result. Existing post-save per-mailbox "Test" button is untouched.

**Edited (5b — campaigns)**
- `lib/campaign-recipients.ts` `buildQueueItemRows` — now takes `rotateEvery` (default 1) and `offsetIndex` (default 0); rotation uses `Math.floor((i+offsetIndex)/rotateEvery) % len` for BOTH mailbox and variant (block rotation, exactly the plan's formula; `rotateEvery: 1` reproduces the old per-recipient behavior).
- `app/api/campaigns/route.ts` `POST` — accepts `rotateEvery?: number`, clamped `Math.max(1, Math.min(1000, Math.floor(n)))`, stored on the created campaign row and passed to `buildQueueItemRows`.
- `app/api/campaigns/[id]/recipients/from-leads/route.ts` — reads the campaign's stored `rotateEvery` and passes `offsetIndex: existingRows.length` so a batch added later continues the rotation at the roster's current index instead of restarting at 0.
- `app/dashboard/campaigns/page.tsx` — "Rotate every N emails" number input (default 1, min 1) between Subject lines and Body, wired into the create POST body.

**Design note / deviation from the literal 5b wording**: the plan's step-3 sentence only rewrote the `mailboxId` formula but the shared helper also rotates `variantId`; I applied the same `floor(i/rotateEvery)` block formula to BOTH so the mailbox and its subject line stay coupled per block (recipients 0..N-1 all get mailbox[0] AND variant[0]), which matches the plan's stated intent ("send N emails from one mailbox/subject"). Verified directly via the helper.

**Validation**
- `npx tsc --noEmit` → exit 0.
- `npm run build` → success; new route registers as `ƒ /api/mailboxes/test-connection`.
- `npx eslint` on every new/changed file → the ONLY findings are **pre-existing at HEAD** (`react-hooks/set-state-in-effect` on the mailboxes page `load()` effect + campaigns page `load()`/`setLeadCountError`, an unused `exhaustive-deps` disable, and the `react/no-unescaped-entities` on the mailboxes page's already-uncommitted "Chrome may warn…" line and the campaigns modal's "You'll") — none introduced by this piece; left untouched per the prior handoff discipline.
- `buildQueueItemRows` exercised directly via `tsx`: `rotateEvery=1` → `m0/v0 m1/v1 m0/v2 m1/v0 …` (old per-recipient); `rotateEvery=2` → `m0/v0 m0/v0 m1/v1 m1/v1 …` (2 share mailbox+variant); `offsetIndex=7` after 7 items → `m1/v0 m0/v1` (continues, not restarts); `leadToRecipient` still trims email keeping casing, omits blank merge vars, `null` on blank email.

**For the next agent**: `app/dashboard/mailboxes/page.tsx` and `app/globals.css` still carry their pre-existing (Piece 5/6 context) uncommitted changes — I only touched the mailbox modal's Security select + Test button region of that page and left the rest (and `globals.css`) alone. `rotateEvery`/`allowInsecure` were applied to the LOCAL dev DB; a prod deploy just needs `prisma migrate deploy` for `20260912030000_add_mailbox_allow_insecure_and_campaign_rotate_every`.

### Note: "select validated / merged leads for the mailer" is already Piece 4 — no new design needed

Re-reading the ask against the plan already written above: Piece 4's "Pick from my leads" picker (scoped to `validationStatus: "valid"`, filterable by source job) already covers exactly this — a merged lead (Piece 2) is just a normal `Lead` row afterward, so once it's validated (Piece 3) it's automatically selectable through Piece 4's picker with no extra work. **Piece 4 has not been implemented yet** — this is a reminder to actually build it (it's the piece that turns "we have leads" into "leads can reach the mailer"), not a sign anything about its design needs to change.

### "Ready for AI automation linking" — a design note, not a new build

The user asked that the system be "ready" for a future AI-driven automation layer (e.g., an agent that decides when to validate a batch, merge duplicates, or enroll leads into a campaign) — NOT a request to build that orchestration now (Piece 4 already explicitly defers a fully-automatic no-human-step pipeline as future work, and that reasoning still holds). What "ready" concretely means for Pieces 3–5, and should be kept true rather than actively built: every mutating action (validate a job's leads, merge N leads, add leads-by-id to a campaign, test a mailbox) is already a plain authenticated REST endpoint with a typed JSON body/response — the same shape whether a human clicks a button or a future service calls it programmatically. Nothing in Pieces 3–5 should be built as UI-only client-side logic with no server route behind it (e.g., don't compute a merge client-side and PATCH raw fields — go through `/api/leads/merge` as designed) — that's the one concrete discipline this note asks Cline to hold to, since it's what "AI-automatable later" actually depends on architecturally. No new endpoint, webhook, or agent-facing API is part of this pass.

**Confirmed intended direction for the actual future AI/agent layer (not part of this pass's build, recorded here so Piece 6's Automations page and any later integration work start from the right assumption):** the user's plan is to route SpaceWorker's AI/agent features through **Channelry's existing Groq integration as an external service**, rather than SpaceWorker standing up its own separate AI provider/key management — reusing infrastructure already proven there (per this session's own memory: Channelry runs a pooled Groq+Cloudflare setup specifically to avoid per-user key-setup friction) instead of duplicating it. AI usage is to be **calculated per user** (for cost tracking/limits), mirroring the kind of per-user usage accounting Channelry's own AI features already need. **Not yet specified and needs its own confirmation pass before any real building starts**: the exact API contract between SpaceWorker and Channelry's Groq integration (a direct HTTP call to a Channelry-hosted endpoint? A shared internal service? Channelry's own database reachability from SpaceWorker's VPS?), the auth/identification mechanism tying a SpaceWorker user to a usage-tracking record, and where that per-user usage ledger actually lives (a new SpaceWorker table calling out to Channelry, or Channelry tracking it on SpaceWorker's behalf). Do not have Cline guess at this wiring — it needs a dedicated follow-up task doc, written after directly reading Channelry's actual Groq integration code (not from memory alone), the same way every other piece in this doc was grounded in the real current code before being handed off.

### Verification (Piece 5)

1. 5a: enter a real mailbox's correct host/port/username/password with each of the three security options, click "Test connection" before saving, confirm success; enter a deliberately wrong password, confirm the pre-save test fails with a clear message and does NOT save the mailbox. Confirm choosing "STARTTLS (port 587)" and saving reproduces the now-fixed real-world case (a real Brevo or Gmail account) working end-to-end, unlike before this fix.
2. 5b: create a campaign with 2 mailboxes, 2 subject variants, `rotateEvery: 3`, and 10 recipients; confirm queue items 0-2 get mailbox/variant index 0, items 3-5 get index 1, items 6-8 index 0 again, item 9 index 1 (i.e. `floor(i/3) % 2`). Confirm a campaign created with `rotateEvery` omitted (or old campaigns created before this migration) still rotates every single recipient exactly as today.

---

## Piece 6 — Nav restructure: fold Mailboxes into Campaigns, add an Automations & Agent section

### Confirmed current state

`components/dashboard-nav.tsx`'s `NAV_ITEMS` (the single source of truth both the desktop Dock and mobile nav render from — do not edit either rendering component directly, only this array): `Overview, Extract, Mailboxes, Campaigns, Browser Profiles, Private Browser, Settings`. `Mailboxes` is its own top-level route (`/dashboard/mailboxes`, `app/dashboard/mailboxes/page.tsx`) and `Campaigns` is separate (`/dashboard/campaigns`, `app/dashboard/campaigns/page.tsx`).

### The change

1. **Remove `Mailboxes` from `NAV_ITEMS`** — it's purely SMTP-account configuration FOR campaigns, not a standalone destination; folding it removes a top-level item that only ever exists to feed the one next to it.
2. **Move mailbox management INTO the Campaigns page as a tab/section**, not a separate route: `app/dashboard/campaigns/page.tsx` gets a simple two-tab header ("Campaigns" / "Mailboxes", reuse whatever tab-switch pattern already exists elsewhere in this app if one does, otherwise a minimal `useState<"campaigns"|"mailboxes">` toggle is enough — this doesn't need the Tabs primitive from Vantra, that's a different codebase) — the "Mailboxes" tab renders the EXACT existing UI currently at `app/dashboard/mailboxes/page.tsx` (including Piece 5's new pre-save test button + security selector), just relocated, not rebuilt. Keep `app/dashboard/mailboxes/page.tsx` itself as a route that redirects to `/dashboard/campaigns?tab=mailboxes` (or equivalent) rather than deleting it outright, in case anything has it bookmarked — same "old-URL-redirects" convention already used elsewhere in this app's history (see Vantra's own V2.1 pass for the precedent, though that's a different repo — the principle is the same: don't 404 an old URL, redirect it).
3. **Add a new top-level nav item "Automations"** (single label covering both "automations and agent" — one menu entry, not two) pointing at a new route `/dashboard/automations`, `app/dashboard/automations/page.tsx`. Since none of the actual automation/agent functionality exists yet (Piece 4's leads→mailer wiring isn't built, and no AI-agent orchestration is planned as a concrete build per Piece 5's "ready for, not built now" note), this page ships as a clear placeholder for this pass: a simple "Coming soon" card explaining what will live here (leads→campaign automation, once Piece 4 ships) rather than an empty page or a hidden nav item — same "show the roadmap, mark it disabled/coming-soon" convention as any other not-yet-built feature, not a fake fully-built UI. Once Piece 4 actually ships, ITS "pick from my leads" picker described above should live on this new page (or be linked from it) rather than bolted only onto the campaign-creation form — Cline's call on exact placement when that piece is built, but the nav slot is being created now so Piece 4 has a real home instead of needing its own future nav change.
4. Pick an icon from the already-installed `lucide-react` for the new item (e.g. `Zap` or `Bot` — either reads as "automation," Cline's call) — no new icon dependency.

### Explicitly out of scope (Piece 6)

- Building any real automation/agent logic on the new page — it's a placeholder + nav slot for Piece 4 and beyond, not a new feature in itself.
- Restructuring `Campaigns` beyond adding the Mailboxes tab (e.g. don't also fold in Piece 4's picker here — that's Piece 4's own scope, landing on the new Automations page per point 3 above).

### Verification (Piece 6)

1. Confirm `Mailboxes` no longer appears as its own top-level nav item (desktop Dock AND mobile nav row — both render from the same `NAV_ITEMS`, so fixing one fixes both, but check both surfaces since they render as visually distinct components).
2. Confirm the Campaigns page's new Mailboxes tab shows the exact same mailbox list/add/edit/test functionality as before the move (nothing lost in the relocation), and that visiting the old `/dashboard/mailboxes` URL directly redirects cleanly instead of 404ing.
3. Confirm the new "Automations" nav item appears, links to a real (if placeholder) page, and doesn't error.

### ✅ IMPLEMENTED (2026-09-12) — Piece 6, what changed & where, for the handoff

All Piece 6 changes landed in `components/dashboard-nav.tsx`, `app/dashboard/campaigns/page.tsx`, `app/dashboard/automations/page.tsx`, a relocated `components/mailboxes-panel.tsx`, and `app/dashboard/mailboxes/page.tsx`. Verified: `npx tsc --noEmit` exits 0, `npm run build` exits 0 with `/dashboard/automations` registered, and ESLint on all changed files reports only findings that already exist at HEAD (none introduced here).

- **Nav (`components/dashboard-nav.tsx`)** — removed the `Mailboxes` item from `NAV_ITEMS` (both the desktop Dock and the mobile row render this same array, so both drop it together) and added a new top-level **"Automations"** item (`/dashboard/automations`) using lucide-react's existing `Zap` icon (no new dependency). No other ordering/semantics changed.
- **Mailboxes folded into Campaigns** — the entire mailbox-management UI was relocated verbatim (not rebuilt) into a new shared client component `components/mailboxes-panel.tsx` (default export renamed `MailboxesPanel`). It keeps Piece 5a's pre-save "Test connection" button + Security select and the per-mailbox inline test/Active/Paused UI — nothing lost. `app/dashboard/campaigns/page.tsx` now renders a two-tab header ("Campaigns" / "Mailboxes") and, when the Mailboxes tab is active, renders `<MailboxesPanel />` in place (wrapping the old campaigns content in a fragment/ternary).
  - **Tab state design note**: the plan OK'd a minimal `useState<"campaigns"|"mailboxes">` toggle. I used a URL-`?tab`-driven approach instead (a `searchParams`-derived const + a `switchTab()` that `router.push`es) because the legacy `/dashboard/mailboxes` URL must open the correct tab, and it keeps the address bar deep-linkable (e.g. `/dashboard/campaigns?tab=mailboxes`). Functionally equivalent to the planned toggle; `?tab` is simply "the" tab source of truth now.
- **Legacy route kept alive (`app/dashboard/mailboxes/page.tsx`)** — rewritten from the old client page into a tiny server page that calls `redirect("/dashboard/campaigns?tab=mailboxes")`, so any bookmarked deep link lands on the folded-in Mailboxes tab instead of 404ing. The dashboard layout still gates auth/verification before this runs.
- **Automations placeholder (`app/dashboard/automations/page.tsx`)** — new hook-free page with a "Coming soon" card explaining what will live there (leads→campaign automation once Piece 4 ships), filling the new nav slot so Piece 4 has a real home rather than needing a future nav change.

### Validation (Piece 6)
- `npx tsc --noEmit` → exit 0, no output; `npm run build` → exit 0 with `/dashboard/automations` (ƒ), `/dashboard/mailboxes` (ƒ redirect), `/dashboard/campaigns` (ƒ) all registered.
- ESLint on the five touched files → only pre-existing-at-HEAD findings carried through: the `load()`-setState-in-effect + unused `exhaustive-deps` disable + "You'll" unescaped entity in `campaigns/page.tsx`, and the equivalent `load()`-setState-in-effect + unescaped-entity lint in the mailbox UI (now `mailboxes-panel.tsx`). None introduced by this piece; left untouched per the prior handoff discipline.
- Logic spot-check: `tab` resolves to `"mailboxes"` iff `?tab=mailboxes` (else `"campaigns"`); `switchTab` short-circuits on the current tab and otherwise navigates (`/dashboard/campaigns?tab=mailboxes` ⇄ `/dashboard/campaigns`); the fragment/ternary JSX structure was re-verified via the successful compiled build.
- Operationally: the working tree had pre-existing uncommitted edits to `app/dashboard/mailboxes/page.tsx` and `app/globals.css` in the Piece 5 handoff. `page.tsx`'s prior (mailbox-UI) edits are superseded by this piece's redirect rewrite — their live code now resides in the relocated panel — and `app/globals.css` was left untouched. No DB schema or migration changes: Piece 6 is pure front-end/nav.

---

## Piece 7 — Real usage feedback on Pieces 1-4's deployed UI

Written after the user tested the live Pieces 1-4 deploy directly. Each item below was checked against the actual current code (`app/dashboard/extract/page.tsx`) before being written up — some are confirmed bugs, some are confirmed-built-but-not-discoverable, one is a genuinely new feature.

### 7a. CONFIRMED BUG: the validation summary leaks across different jobs

**Confirmed by reading the code**: `validateMessage` (`useState<string | null>`, ~line 135) is a single piece of component state set once by `validateAll()`'s response (`` `${data.valid} valid, ${data.invalid} invalid` ``, ~line 491) and rendered unconditionally next to the action buttons (~line 1055) — nothing clears or recomputes it when `selectedJob` changes. Confirmed live: the user validated job A (1501 valid / 55 invalid), then switched to a completely different job B that had never been validated, and job B's action bar still showed "1501 valid, 55 invalid" — a stale result from job A with no indication it belongs to a different job.

**The fix**: stop treating this as a one-shot POST-response message and make it a **live, derived summary of the currently selected job's own leads** instead — computed from `selectedJob.leads`' own `validationStatus` values (`leads.filter(l => l.validationStatus === "valid").length`, same for `"invalid"` and `"unchecked"`), recalculated on every render of the detail pane (a plain `const`, not state — it already has everything it needs in props/state that changes on job switch). This has two benefits beyond fixing the bug: it can never go stale (switching jobs, or the leads array updating after a validate call, both naturally recompute it), and it can show a running unchecked count too ("1501 valid · 55 invalid · 4 unchecked") instead of only appearing after a validate click. Keep `validateBusy`/the button's own disabled-state logic as-is; only the *summary line* changes from "one-shot server message" to "live derived count."

### 7b. Select-all checkbox for the leads table

**Confirmed missing**: the table header's checkbox column (~line 1118, `<th className="w-6 pb-2" aria-label="Select">`) is a static, non-interactive cell — there is no way to select every (visible) lead at once, only one-by-one via each row's own checkbox.

**The fix**: make that header cell a real checkbox wired to the same `selectedIds`/`toggleSelected` state Piece 2 already built. Checked state = every currently-rendered lead's id is in `selectedIds` (respect Piece 1's `visibleLeads` filter — "select all" in Emails-only mode should only select the emails actually shown, not ones hidden by the filter); clicking it when unchecked adds all `visibleLeads` ids to the set, clicking when checked (or indeterminate) clears just those ids from the set (don't clear a selection the user made on a *different* job's leads if that's somehow still around — in practice `selectedIds` should already reset on job switch, confirm it does).

### 7c. New action: delete the invalid leads after validating

**The ask**: after running "Validate all," there's no way to discard the invalid ones and keep only the valid leads — the user has to individually check-and-do-something with 55 bad rows, or ignore them forever.

**The fix**: new route `app/api/jobs/[id]/leads/delete-invalid/route.ts`, `POST` — auth + ownership-gated (404 on a job that isn't the caller's, matching convention), `prisma.lead.deleteMany({ where: { searchJobId: id, userId: session.userId, validationStatus: "invalid" } })`, returns `{ deleted: count }`. UI: a button next to the (now-live, per 7a) validation summary — "Delete N invalid" — only rendered when the live invalid count is > 0, behind a plain confirm (`window.confirm` is fine here, matching this app's existing lightweight-confirm convention elsewhere, or reuse whatever confirm-dialog pattern Piece 2's merge flow already established if one exists — Cline's call, don't invent a third pattern). On success, refetch the job detail so the table drops the deleted rows immediately.

### 7d. Job date shown per session, plus a 30-day auto-deletion policy

**Confirmed missing**: neither the job-list row nor the detail-pane header renders `job.createdAt` anywhere (grepped both `extract/page.tsx` and `api/jobs/route.ts` — the field exists on every `SearchJob` row already, it's just never displayed).

**The fix, display half**: add a relative-date caption next to `summarizeQuery(...)` at both call sites — reuse the exact `timeAgo()` helper already written for Piece 5a's mailbox "last tested" caption (`app/dashboard/mailboxes/page.tsx`, ~line 69: `"just now"` / `"Nm ago"` / `"Nh ago"` / `"Nd ago"`) rather than writing a second date-formatting function — move it to a shared `lib/format-date.ts` (or similar) if it doesn't already live somewhere both pages can import from, since it's now needed in two places.

**The fix, retention half — a real decision, not a trivial add**: "delete after 30 days" needs a policy decision before it needs code: does this mean deleting the whole `SearchJob` + its `Lead` rows 30 days after `createdAt`, regardless of whether those leads were ever validated, merged, exported, or added to a campaign? A lead a user validated and is actively relying on for an ongoing campaign getting silently deleted on day 31 would be a real problem, not a cleanup. **Recommended, conservative interpretation** (confirm with the user before building, don't assume): only auto-delete a `SearchJob` (cascade to its `Lead`s) when ALL of — older than 30 days AND status is a terminal one (`done`/`stopped`, never `running`/`paused`) AND none of its leads have ever been referenced by an `EmailQueueItem` (i.e., never used in a campaign) — are true. Implementation: this app has no cron/background-job infrastructure beyond the existing dispatch-tick pattern (`app/api/internal/dispatch/route.ts`, called periodically by the same external scheduler that already drives job dispatch and mail-queue draining) — add the retention sweep as one more thing that same scheduled call does (or a sibling `app/api/internal/retention-sweep/route.ts` hit by the same cron on a longer interval, e.g. once a day rather than every dispatch tick), not a new piece of infrastructure. Log what got deleted (count + a sample of ids) via whatever this app's existing lightweight logging convention is, so a surprising mass-deletion is at least traceable after the fact.

### 7e. Actions row redesign — group into a cleaner control, not five buttons in a line

**Confirmed by reading the code** (~lines 1000-1058): the detail-pane header currently renders up to five separate same-styled controls in one flex row — Pause/Resume (job control), Export CSV, Emails only, Create email campaign, Validate all — plus the (per 7a, soon-to-be-live) validation summary text. No visual hierarchy distinguishes "the one action you'll use most" from "an export format variant you'll use rarely."

**The fix**: keep job-control (Pause/Resume) and the primary "Create email campaign" as their own visible buttons (these are the two most common next actions), but collapse the export variants (Export CSV / Emails only) and Validate all into a single "Actions" dropdown/menu button — this app has no existing dropdown-menu primitive to confirm and reuse (grep for one before building a second one if it turns out one already exists elsewhere), so introduce one plain, accessible dropdown (a button + an absolutely-positioned menu panel, closed on outside-click/Escape, no new dependency needed for something this simple) and use it here first. This directly addresses the ask for the campaign/export controls to "look better" without inventing new functionality — it's the existing five actions, reorganized.

### 7f. Merge and Import-leads: confirmed built, likely a discoverability gap — verify with the user rather than rebuilding

**Confirmed by reading the code**: both exist today. Merge: checkboxes on every leads-table row (~line 1140) plus a floating "N leads selected · Merge N leads" action bar that appears once 2+ are checked (~line 1185-1194) — this is Piece 2, already shipped. Import: an "Import leads" button top-right of the whole Extract page, next to the "Extract Leads" heading (~line 660-666), opening a drag-and-drop dialog — this is Piece 3, already shipped.

Given both are confirmed present in the exact code the user was testing, "no option to merge" / "no option to upload" most likely means **not discovered**, not **not built** — the Import button sits at the very top of the page while the user's actual attention was deep in a specific job's detail pane (scrolled well past it), and the Merge bar only appears after checking 2+ boxes, which is easy to never attempt if nothing invites the click. Before Cline spends time rebuilding either: **re-confirm with the user, screen-sharing or a fresh screenshot, whether these are actually invisible/broken or simply weren't noticed** — if genuinely a discoverability problem, the fix is relocating/emphasizing what already exists (e.g., a persistent "Import leads" affordance inside the leads pane itself, not only at the page's top; a lighter-weight, always-visible "Select leads to merge" toggle instead of relying on the bar appearing only after 2 checks are already made), not reimplementing the underlying feature.

### 7g. A real motion pass, broader than Piece 1d's row fade-in

**Context**: Piece 1d added a `fadeInUp` CSS animation to leads-table `<tr>` elements only. The user's "no animation during any of this" feedback, given after using validate/merge/import/the actions row, suggests the ask was always broader than new-row entrance — button presses, modal open/close (the merge dialog, the upload dialog), and validation's own busy/success/done states currently all snap instantly with no transition, which reads as "no animation" even though Piece 1d's specific row effect is technically present.

**The fix**: this is a real design pass, not a one-line tweak — **load the `design`/`artifact-design` conventions this session already has access to for calibrating motion treatment** (a utilitarian tool like this doesn't need showy animation, but *some* deliberate transition on state changes reads as considered rather than broken) rather than Cline improvising CSS keyframes ad hoc a second time. Concrete, bounded scope for this pass: (1) the two modals (merge, upload) get an entrance/exit transition instead of popping in/out instantly — reuse whatever transition approach Piece 1d settled on (CSS-only, no new dependency, given that constraint held for the whole rest of this doc); (2) "Validate all" gets a visible busy state beyond the button's own text changing to "Validating…" — e.g. a small inline spinner — so a validation that takes a few seconds (DNS lookups aren't instant) doesn't look stalled; (3) the (per 7a) live validation-summary line transitions/crossfades when its numbers change, same `key`-based crossfade approach already used for the relocated "Currently: …" activity text in Piece 1b, for consistency.

### Verification (Piece 7)

1. 7a: validate job A, note its valid/invalid counts, switch to a never-validated job B, confirm the summary either shows job B's own (zero/unchecked) state or disappears — never A's stale numbers. Validate job B, confirm ITS numbers appear, switch back to A, confirm A's original numbers are still correct (not overwritten by B's).
2. 7b: with a filter active (e.g. Emails-only mode hiding some leads), click select-all, confirm only the visible/filtered leads get selected, not ones hidden by the filter.
3. 7c: validate a job with a mix of valid/invalid, click "Delete N invalid," confirm exactly the invalid rows are gone and valid ones remain untouched; confirm the button doesn't appear at all once invalid count is 0.
4. 7d: confirm a relative date appears on every job (list + detail); for the retention sweep, test against a manually-backdated job row (set `createdAt` >30 days ago directly in the DB for a test job) in each of the three disqualifying states (running, has a campaign-linked lead, <30 days old) and confirm none of those get swept, then confirm a genuinely-eligible old/unused/terminal job does.
5. 7e: confirm the collapsed actions dropdown contains Export CSV/Emails only/Validate all, opens/closes correctly (outside-click, Escape), and every action inside still works exactly as before the visual regrouping.
6. 7f: get explicit confirmation from the user (screenshot or live check) on whether Merge/Import are now noticed once pointed at their current locations, before deciding whether relocation work is still needed.
7. 7g: manually trigger each of the three motion additions (open/close both modals, run a validation, watch the summary line update) and confirm each transitions rather than snaps.

### ✅ IMPLEMENTED (2026-09-12) — Piece 7, what changed & where, for the handoff

All Piece 7 sub-items landed and were statically verified (`npx tsc --noEmit` exit 0, `npm run build` exit 0 with both new routes registered, ESLint clean on every new file). The items marked ☆ still need a live/user check before Piece 7 is fully "closed" — nothing about them blocks the functionality.

- **7a (stale validation summary → live derived counts, `app/dashboard/extract/page.tsx`)** — deleted the one-shot `validateMessage` state; `validateAll()` now sets only an error (`validateError`) and no longer posts back a success string. The summary is now a plain derived const rendered in the actions row: `vValid` / `vInvalid` / `vUntested` counted from `selectedJob.leads`' own `validationStatus` on every render (switching jobs — or the leads array updating after a validate — recomputes it, so it can never show another job's numbers). Shows a running unchecked count too, and only renders once something has been validated (so a fresh job isn't cluttered with zeros).
- **7b (select-all checkbox, same file)** — the header `<th aria-label="Select">` is now a real checkbox wired to Piece 2's `selectedIds`. "All" = all currently-rendered leads (respects the `visibleLeads`/Emails-only filter), with indeterminate (`!allVisibleSelected && someVisibleSelected`) via a callback ref; `onToggleSelectAll` mutates a copy and adds/clears just the visible ids. `selectedIds` already resets on job switch (the job-list row's onClick), so this can't touch a different job's selection.
- **7c (delete invalid leads, new route + UI)** — new `app/api/jobs/[id]/leads/delete-invalid/route.ts` (`POST`, auth + ownership-gated with the 404-on-not-yours convention, `lead.deleteMany({ where: { searchJobId, userId, validationStatus: "invalid" } })`, returns `{ deleted }`). UI: a red "Delete N invalid" button next to the 7a summary, rendered only while `vInvalid > 0`, behind `window.confirm` (reused the app's lightweight-confirm convention — see `deleteJob`), then refetches the job detail + job list.
- **7d (job date + 30-day retention, display + new route)** — display: moved `timeAgo()` out of `components/mailboxes-panel.tsx` into a new shared `lib/format-date.ts` (the panel now imports it), and added a `· {timeAgo(createdAt)}` relative-date caption to both the job-list row and the detail-pane header. Retention: new `app/api/internal/retention-sweep/route.ts` (`POST`, gated by `INTERNAL_BEARER_TOKEN`), a sibling of `dispatch` hit by the external scheduler on a long interval. **Policy confirmed with the user (conservative)**: only sweeps a `SearchJob` when it's older than 30 days AND status is `done`/`stopped` (never running/paused/queued, and not `failed`) AND none of its leads' emails ever appear in `EmailQueueItem.toEmail`. Deletes leads + `JobQueueEntry` rows before the job (required FKs, no onDelete action) in one `$transaction`, and `console.log`s the swept count + a sample of ids for traceability.
- **7e (Actions dropdown, new reusable primitive)** — new `components/dropdown.tsx` (`Dropdown` / `DropdownItem`; outside-click + Escape close, `role="menu"`/`menuitem`, link vs button items via `href`/`onSelect`, `danger` + `busy` item states). Used as a reusable primitive here first ("use it here first"): in the detail-pane actions row, Pause/Resume (job control) and **Create email campaign** stay as visible buttons; **Export CSV / Emails only / Validate all** are collapsed into one right-aligned "Actions" dropdown. (Note: `components/menu-bar.tsx` has an OS-style `MenuDropdown`, but it's File/Window/Help-specific and not a usable generic — left untouched as unrelated working code.)
- **7f (Merge + Import — confirmed built, NOT rebuilt)** — verified by reading code that both exist: merge = per-lead checkboxes + a floating "N leads selected · Merge N leads" bar (Piece 2); import = the top-right "Import leads" button + drag-drop dialog (Piece 3). No relocation work done. **☆ Still needs the user to confirm (screenshot / screen-share) whether these are actually invisible/broken rather than simply not noticed** before any emphasis/relocation work — the plan-mandated gate; don't guess past it.
- **7g (motion pass)** — (1) both modals (merge + upload) got a CSS-only `fadeInUp` entrance transition on their card (no new dependency, same approach as Piece 1d). A true EXIT animation would require keeping the modal mounted + delaying unmount, so close is still immediate — entrance-only, as a bounded CSS-only pass. (2) "Validate all" now shows a busy state inside the Actions dropdown: new `@keyframes spin` in `app/globals.css` + a `DropdownItem.busy` inline ring spinner. (3) the 7a live summary line is keyed on its numbers (`key={`${vValid}-${vInvalid}-${vUntested}`}`) so it replays the `fadeInUp` crossfade when the counts change, matching the relocated "Currently: …" line.

**Validation (Piece 7):** `npx tsc --noEmit` → exit 0, no output. `npm run build` → exit 0; both new routes registered (`/api/internal/retention-sweep`, `/api/jobs/[id]/leads/delete-invalid`). ESLint: clean on all new files; `extract/page.tsx` shows ONLY the pre-existing-at-HEAD `set-state-in-effect` at ~line 209, which this doc says to leave untouched. No new dependencies; no DB schema/migration changes (7c/7d reuse the existing `Lead`/`SearchJob`/`EmailQueueItem`/`JobQueueEntry` models).

**Remaining for the next agent (verification-only, no code):** ☆ run Verification item 4 against a manually-backdated job in each of the three disqualifying states (running / has-a-campaign-linked-lead / <30 days old — none swept) plus a genuinely-eligible one (swept); ☆ 7f: get the user's confirmation on Merge/Import discoverability before any relocation; ☆ 7g: visually confirm both modal entrances, the validate spinner, and the summary crossfade actually transition.

---

## Explicitly out of scope, all pieces

- SMTP-handshake or send-a-real-test-email style validation (the standalone doesn't do this either — MX-record checking is the proven, fast, reliable approach being ported).
- Fuzzy/similarity-based automatic duplicate detection (the standalone's `is_similar_email` exists but isn't wired into any UI there either) — merging stays a manual, user-initiated action for v1.
- Any change to the existing CSV-upload path already used by campaigns.
- A fully automatic (no human click) leads→mailer pipeline — see Piece 4's explicit deferral.
- Any AI agent/orchestration layer itself — Piece 5's "ready for AI automation linking" note is an architectural discipline (plain REST endpoints behind every mutation), not a new agent-facing API or webhook.

## Verification checklist (all pieces)

1. Piece 1: open a job with a long multi-term query, confirm only the compact summary shows (with the full string in a hover tooltip), confirm new leads auto-scroll into view while the job runs, confirm scrolling up manually to review earlier leads doesn't get yanked back down, confirm the activity-log line now sits under the table.
2. Piece 2: select 3 leads from the same job with overlapping data, merge them, confirm exactly 1 new row exists with the chosen field values and the 3 originals are gone; attempt a merge across two different jobs and confirm it's rejected with a clear error.
3. Piece 3: upload a small `.csv` with mixed valid/garbage emails, confirm the parse count and permissive import (garbage rows with no email dropped, everything else kept), run "Validate all," confirm the valid/invalid split matches manual inspection (test at least one domain with genuinely no MX records, e.g. a typo'd domain, to confirm the "invalid" path actually triggers, not just the happy path).
4. Piece 4: run the 3-step verification under Piece 4 itself above.
5. Piece 5: run the 2-step verification under Piece 5 itself above.
6. Full regression: confirm the existing job-list/detail flow (pause/resume/stop/export CSV) still works unchanged after Piece 1's layout changes, and the existing mailbox post-save "Test" button + CSV-based campaign creation both still work unchanged after Piece 5's additions.
