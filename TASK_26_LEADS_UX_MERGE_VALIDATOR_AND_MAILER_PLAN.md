# Task 26 — Leads dashboard redesign, merge, email validator + upload, and a leads→mailer automation plan

**Status: Pieces 1 and 2 IMPLEMENTED and verified (2026-09-12). Pieces 3–5 ready — start with Piece 3.** Written 2026-09-12, based on directly reading the current `app/dashboard/extract/page.tsx` (897 lines), the current `Lead`/`SearchJob` Prisma models, and the standalone Lead Extractor's own proven validator (`app/lead_manager/validator.py`) and file-uploader (`app/lead_manager/uploader.py`) — Piece 3 below ports their actual logic, not a guess at what "validation" should mean. Piece 5 added 2026-09-12 after live user feedback on the mailboxes/campaigns UI.

Pieces are independent and can be built/shipped in any order, but 1 is the fastest win and 3 is a prerequisite for 4's "extracted + validated" selection filter. Piece 5's two halves (5a mailbox testing, 5b rotation batch size) are also independent of everything else and of each other.

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

### Note: "select validated / merged leads for the mailer" is already Piece 4 — no new design needed

Re-reading the ask against the plan already written above: Piece 4's "Pick from my leads" picker (scoped to `validationStatus: "valid"`, filterable by source job) already covers exactly this — a merged lead (Piece 2) is just a normal `Lead` row afterward, so once it's validated (Piece 3) it's automatically selectable through Piece 4's picker with no extra work. **Piece 4 has not been implemented yet** — this is a reminder to actually build it (it's the piece that turns "we have leads" into "leads can reach the mailer"), not a sign anything about its design needs to change.

### "Ready for AI automation linking" — a design note, not a new build

The user asked that the system be "ready" for a future AI-driven automation layer (e.g., an agent that decides when to validate a batch, merge duplicates, or enroll leads into a campaign) — NOT a request to build that orchestration now (Piece 4 already explicitly defers a fully-automatic no-human-step pipeline as future work, and that reasoning still holds). What "ready" concretely means for Pieces 3–5, and should be kept true rather than actively built: every mutating action (validate a job's leads, merge N leads, add leads-by-id to a campaign, test a mailbox) is already a plain authenticated REST endpoint with a typed JSON body/response — the same shape whether a human clicks a button or a future service calls it programmatically. Nothing in Pieces 3–5 should be built as UI-only client-side logic with no server route behind it (e.g., don't compute a merge client-side and PATCH raw fields — go through `/api/leads/merge` as designed) — that's the one concrete discipline this note asks Cline to hold to, since it's what "AI-automatable later" actually depends on architecturally. No new endpoint, webhook, or agent-facing API is part of this pass.

### Verification (Piece 5)

1. 5a: enter a real mailbox's correct host/port/username/password with each of the three security options, click "Test connection" before saving, confirm success; enter a deliberately wrong password, confirm the pre-save test fails with a clear message and does NOT save the mailbox. Confirm choosing "STARTTLS (port 587)" and saving reproduces the now-fixed real-world case (a real Brevo or Gmail account) working end-to-end, unlike before this fix.
2. 5b: create a campaign with 2 mailboxes, 2 subject variants, `rotateEvery: 3`, and 10 recipients; confirm queue items 0-2 get mailbox/variant index 0, items 3-5 get index 1, items 6-8 index 0 again, item 9 index 1 (i.e. `floor(i/3) % 2`). Confirm a campaign created with `rotateEvery` omitted (or old campaigns created before this migration) still rotates every single recipient exactly as today.

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
