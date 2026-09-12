# Task 26 — Leads dashboard redesign, merge, email validator + upload, and a leads→mailer automation plan

**Status: ready to implement, four independent pieces.** Written 2026-09-12, based on directly reading the current `app/dashboard/extract/page.tsx` (897 lines), the current `Lead`/`SearchJob` Prisma models, and the standalone Lead Extractor's own proven validator (`app/lead_manager/validator.py`) and file-uploader (`app/lead_manager/uploader.py`) — Piece 3 below ports their actual logic, not a guess at what "validation" should mean.

Pieces are independent and can be built/shipped in any order, but 1 is the fastest win and 3 is a prerequisite for 4's "extracted + validated" selection filter.

---

## Piece 1 — Compact leads UI: hide the full query, auto-scroll to newest lead, activity log under the list, motion

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

## Explicitly out of scope, all pieces

- SMTP-handshake or send-a-real-test-email style validation (the standalone doesn't do this either — MX-record checking is the proven, fast, reliable approach being ported).
- Fuzzy/similarity-based automatic duplicate detection (the standalone's `is_similar_email` exists but isn't wired into any UI there either) — merging stays a manual, user-initiated action for v1.
- Any change to the existing CSV-upload path already used by campaigns.
- A fully automatic (no human click) leads→mailer pipeline — see Piece 4's explicit deferral.

## Verification checklist (all pieces)

1. Piece 1: open a job with a long multi-term query, confirm only the compact summary shows (with the full string in a hover tooltip), confirm new leads auto-scroll into view while the job runs, confirm scrolling up manually to review earlier leads doesn't get yanked back down, confirm the activity-log line now sits under the table.
2. Piece 2: select 3 leads from the same job with overlapping data, merge them, confirm exactly 1 new row exists with the chosen field values and the 3 originals are gone; attempt a merge across two different jobs and confirm it's rejected with a clear error.
3. Piece 3: upload a small `.csv` with mixed valid/garbage emails, confirm the parse count and permissive import (garbage rows with no email dropped, everything else kept), run "Validate all," confirm the valid/invalid split matches manual inspection (test at least one domain with genuinely no MX records, e.g. a typo'd domain, to confirm the "invalid" path actually triggers, not just the happy path).
4. Piece 4: run the 3-step verification under Piece 4 itself above.
5. Full regression: confirm the existing job-list/detail flow (pause/resume/stop/export CSV) still works unchanged after Piece 1's layout changes.
