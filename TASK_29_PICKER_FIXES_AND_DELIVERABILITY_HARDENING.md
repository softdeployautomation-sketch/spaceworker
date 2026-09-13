# Task 29 — Picker fixes, recipient control, and real spam-placement checking

**Status: ready for Cline, after Task 28.** Grounded in live-testing feedback (2026-09-12) plus a fresh read of the actual deliverability code (`lib/deliverability.ts`, `lib/seed-mailbox.ts`, `lib/imap.ts`, `SeedMailbox`/`DeliverabilityCheck` in `prisma/schema.prisma`), which turned out to already do more than earlier planning docs assumed: a real SMTP-send + IMAP-poll-confirms-arrival gate already exists (`POST /api/campaigns/[id]/test-send`), it just only checks `INBOX` on one platform-owned mailbox. This doc is six mostly-independent items — do them in the order below, but 1-3 are small and can ship together fast; 4-6 are the bigger piece and deserve their own careful pass.

---

## 1. Fix the picker's confusing labels (quick)

`app/dashboard/campaigns/page.tsx` lines ~608-615: "Select all visible (156)" and "Select all valid across everything (1657)" read like a pagination distinction when they're actually **this session vs. every session**. Relabel:
- `Select all visible (…)` → `Select all in this session ({visibleLeads.length})`
- `Select all valid across everything (…)` → `Select all valid, every session ({pickerData.leads.length})`

No logic change — `selectAllVisible()`/`selectAllValid()` already do the right thing, this is copy only.

## 2. Fix the automation "uploaded lead list" not loading, and support multiple lists

`app/dashboard/automations/page.tsx`'s `loadAll()` fetches `/api/jobs` once in a mount-only `useEffect` (line ~130-133). If a user uploads a list on the Extract page and then opens the Automations page (or the "New automation" modal) without a full page reload, `uploadJobs` is stale/empty — this is the reported "doesn't load the list" bug. Fix: call `loadAll()` (or at least refetch `/api/jobs`) when the "New automation" modal opens, not only on page mount.

Separately — and this is a real missing feature, not just the bug above — `CampaignAutomation.personalListId` is a single `String?`, so only one uploaded session can ever be selected. Change to `personalListIds String[]` (Prisma migration, additive), update:
- `app/dashboard/automations/page.tsx`'s picker to a multi-select (checkboxes, matching the Extract page's own multi-session merge UI convention) instead of a `<Select>`.
- `lib/automation-run.ts`'s `resolveRunRecipients()` equivalent for `personal_list` runs to pull validated leads from *all* selected `SearchJob` ids, deduping by email across them the same way it already dedupes within one job.
- `app/api/automations/route.ts`/`[id]/route.ts`'s create/edit validation to accept the array.

## 3. Let a user insert an ad-hoc recipient into a campaign's queue at a chosen position

New ask: from the Campaigns picker (or the campaign detail view once created), let a user type a single email address and choose where it lands in the send order — "at the top," "after position N," or "every Nth recipient" (the last form matters most once item 4-6's batch-checking lands, since it's how a user drops their own test mailbox into the middle of a real run to eyeball it live).

Minimum viable version: a text input + a position selector (`top` | `position N` | `every N`) that inserts a synthetic recipient row into `buildQueueItemRows`'s output before `createMany` runs — `lib/campaign-recipients.ts` already assigns `mailboxId`/`variantId` per row by index, so an inserted row just needs to go through the same assignment, not bypass it. Store it as a normal `EmailQueueItem` (no schema change needed) with a `source: "manual_insert"` marker if useful for the run-detail UI to label it distinctly from extracted/uploaded/picked leads (check whether `EmailQueueItem` already has a place for this or needs one small column).

## 4. Decouple subject and body rotation

Today a `CampaignVariant` is a subject+body **pair** — rotation picks one pair per recipient. Change to two independent lists (subjects, bodies) that each rotate on their own index, cross-combined per recipient (recipient *i* gets `subjects[i % subjects.length]` + `bodies[i % bodies.length]`, not tied together) — this multiplies effective variety without requiring the user to write every subject×body combination by hand. This does touch the campaign-builder UI (`app/dashboard/campaigns/page.tsx`'s variant editor) and `lib/campaign-recipients.ts`'s `buildQueueItemRows` — check with the user before landing this if the cross-combination framing above isn't actually what they meant by "rotate the body as well"; it's a reasonable read of the ask but wasn't spelled out in detail.

**Explicit fallback, owner-specified 2026-09-12**: rotation is per-dimension and only applies where a dimension actually has more than one entry — a single-item list is never an error, it's just held constant while the other dimensions still rotate. Concretely, for each dimension independently (mailboxes, subjects, bodies): if `list.length <= 1`, every recipient gets `list[0]` (or the single mailbox); only if `list.length > 1` does `i % list.length` actually vary across recipients. This generalizes cleanly to mailboxes too (a campaign with one SMTP mailbox and 3 subjects/3 bodies should rotate subjects and bodies normally while every send goes out from that one mailbox — check `lib/campaign-recipients.ts`'s existing mailbox-rotation math already behaves this way for the single-mailbox case, since `i % 1 === 0` is already a degenerate no-op, but confirm rather than assume once subjects/bodies are split into independent lists alongside it).

---

## 5-6. Real spam-placement checking — the bigger piece

### The decided scope (owner's call, 2026-09-12)

Hybrid, not all-automated and not all-manual:
- **Where the IMAP server supports it** (works generically — see below, not Gmail-only), automatically detect whether a test message landed in Inbox or Spam/Junk and gate on that.
- **Where it can't be detected** (provider doesn't expose it, or the user is testing against a plain SMTP-only account with no IMAP access), fall back to human-in-the-loop: the user checks a real inbox themselves and clicks Continue / Try a different subject.
- **Users can register their own test account** (their own Gmail, or anything else with IMAP access) as an alternative to the platform's shared seed mailbox — because a user's own Gmail may filter differently than the platform's, and because they may be sending to non-Gmail recipients they want their own signal on.

### 5. Schema + per-user seed/test mailboxes

`SeedMailbox` (`prisma/schema.prisma` ~line 164) is currently a single platform-wide row with no `userId` — its own comment already anticipated more rows ("the model already supports N"), it just needs the ownership column:

```prisma
model SeedMailbox {
  // ...existing fields unchanged...
  userId String? // null = platform-shared seed (today's default); set = a user's own registered test account
  user   User?   @relation(fields: [userId], references: [id])
}
```

Add a "Test mailbox" section to the Mailboxes tab (`components/mailboxes-panel.tsx`) — separate from sending mailboxes, same host/port/username/app-password form, calling a new `POST /api/test-mailboxes` that encrypts the password the same way `lib/mailbox-crypto.ts` already does for sending mailboxes and creates a `SeedMailbox{ userId: session.userId }` row. A user with no test mailbox registered keeps using the platform default (`ensureSeedMailbox()` / `SeedMailbox.findFirst({ active: true, userId: null })`) exactly as today — this is additive, the existing flow for every current user doesn't change until they opt in.

`DeliverabilityCheck` needs one more column: `landedIn String?` (`"inbox" | "spam" | "unknown"`) — `"unknown"` is what a check reports when spam-folder detection isn't possible for that mailbox's provider, which is exactly the signal the UI uses to decide whether to show "Continue" automatically or ask the user to eyeball it.

### 6. Extend `pollSeedMailbox` to check the Spam/Junk folder too

`lib/imap.ts`'s `pollSeedMailbox()` only ever locks `"INBOX"` (line 54). Extend it to, after checking INBOX and not finding the token there, also check for a spam-equivalent folder:

- **Preferred, provider-generic approach**: use `client.list()` (imapflow) to enumerate folders and find one flagged with the IMAP SPECIAL-USE attribute `\Junk` (RFC 6154 — Gmail, Outlook, and most modern IMAP providers advertise this correctly; verify imapflow's exact API surface for reading special-use flags off `list()` results against its docs before assuming the property name). This is what makes the check work for Gmail AND other providers with the same code path, not a Gmail-specific hardcode.
- **Fallback when special-use isn't advertised**: try common literal folder names (`"[Gmail]/Spam"`, `"Spam"`, `"Junk"`, `"Junk E-mail"`) — best-effort, and if none of them exist/authenticate, report `landedIn: "unknown"` rather than failing the whole check.
- Return shape becomes `{ found: boolean; landedIn: "inbox" | "spam" | "unknown"; messages: string[]; error?: string }`. `runTestSend()` in `lib/deliverability.ts` passes this through into `DeliverabilityCheck.landedIn`.

### Batch-gate behavior (ties 3, 5, 6 together)

On a campaign, let the user set a batch size (default something sane, e.g. 50) alongside the existing `rotateEvery` field. The mail-queue drain (whatever currently reads `EmailQueueItem` rows and sends them — locate the existing drain route/service, likely `app/api/internal/mail-queue-drain/route.ts` per `deploy/mail-queue-drain.service`) pauses after each batch and:
- If the campaign's designated test mailbox (`SeedMailbox` — platform default or the user's own) can be automatically checked (item 6): re-run a `runTestSend`-style check against it. `landedIn: "inbox"` → auto-continue to the next batch. `landedIn: "spam"` → pause the campaign, notify the user (reuse `lib/email.ts`'s `sendEmail`, same as Task 28's item 4 alert), and let them choose Continue-anyway / Switch to a different subject-body pair (picks the next entry from item 4's subject list) / Stop.
- If `landedIn: "unknown"` → always pause for a human check, same UI as the "spam detected" case above, but phrased as "we couldn't verify automatically — please check the test inbox and confirm."
- This is the same use case item 3's "insert a recipient every Nth position" serves: a user can drop their own real address into the batch boundary itself, not just rely on the seed mailbox, and see it arrive in their own client.

**Explicitly build this at the Campaign/send-engine level, not inside the Automation orchestrator.** `lib/automation-run.ts`'s `processSendPhase()` already just calls `createCampaign()` and lets the normal campaign send/confirm machinery take over — the batch gate belongs in that shared machinery so both hand-built campaigns and automation-triggered ones get it automatically, with zero automation-specific code. This is the same "reuse, don't duplicate" discipline the rest of this project has followed (Task 26 Piece 4's REST-endpoint reuse, Task 27/28's `campaign-create.ts` unification) — don't special-case this inside automations.

---

## Sequencing recommendation

1. Items 1-2 (labels + automation list bug/multi-select) — smallest, ship first.
2. Item 3 (insert-recipient) — small, but useful groundwork for testing item 6 once it lands.
3. Item 4 (subject/body decoupling) — confirm the cross-rotation reading with the user before or during implementation if anything is ambiguous once Cline starts.
4. Items 5-6 (schema + per-user test mailboxes + spam-folder detection + batch gate) — the real work in this doc; build and verify against a real Gmail test mailbox before calling it done, the same "verify live, don't trust code-review alone" bar as every deliverability-adjacent piece in this project so far.

## Verification expected before calling this done

- `npx tsc --noEmit` / `npm run build` clean, as always.
- Item 2: confirm live — upload a list, immediately open Automations without reloading, confirm it now appears; confirm selecting 2+ uploaded sessions actually merges their leads (deduped) in a run.
- Item 6: confirm live against a real Gmail test mailbox — deliberately trigger a message that Gmail spam-filters (e.g. an obvious cold-outreach phrase) and confirm `landedIn` correctly reports `"spam"`, not just `"inbox"` on a clean test. A check that only ever reports "inbox" hasn't actually proven the spam-folder path works.
- Report per-item like Task 28, not a single "done" — these are 6 separable pieces of real product surface.

---

## Handoff — implementation status & next steps (updated 2026-09-13)

Implemented (typecheck-clean; DB migrations applied to local postgres). The next agent starts from **"Remaining work"** below.

### ✅ Done — schema + both migrations
- `prisma/migrations/20260912150000_task29_picker_deliverability/migration.sql`
  - `EmailCampaign`: `subjects TEXT[]`, `bodies TEXT[]` (item 4)
  - `EmailQueueItem`: `source TEXT NOT NULL DEFAULT ''`, `resolvedSubject TEXT`, `resolvedBodyHtml TEXT` (items 3+4)
  - `SeedMailbox`: `userId TEXT` + FK to `User` (ON DELETE SET NULL) + `userId` index (item 5)
  - `DeliverabilityCheck`: `landedIn TEXT` (item 6)
  - `CampaignAutomation`: `personalListId` → `personalListIds TEXT[]` **backfilled** from the old column (item 2)
- `prisma/migrations/20260912160000_add_campaign_batch_size/migration.sql` → `EmailCampaign.batchSize INT NOT NULL DEFAULT 50` (item 6)
- **Local-DB caveat**: the postgres role can't create the shadow DB, so `prisma migrate dev` fails with P3014. Both migrations were applied with **`npx prisma migrate deploy`** (no shadow DB needed) + `npx prisma generate`. New agents must use `migrate deploy`, not `migrate dev`. The schema is committed, so `migrate deploy` reproduces it on a fresh clone.

### ✅ Done — per item
- **Item 1** — `app/dashboard/campaigns/page.tsx`: “Select all in this session (N)” / “Select all valid, every session (N)”. Copy-only.
- **Item 2** — `app/dashboard/automations/page.tsx`: `refreshUploadJobs()` now called in `openCreate`/`openEdit` (kills the stale-list bug); personal-list picker is checkbox multi-select (`personalListSelections`); `submitForm` sends `personalListIds` array. Backend: `app/api/automations/route.ts` + `[id]/route.ts` validate/store the array; `lib/automation-run.ts` `resolveRunRecipients()` now takes `jobIds: string[]` and dedups by email across ALL selected lists; `processSendPhase`, `kickOffRun`, `confirmDailyRun` resolve the correct id set.
- **Item 3** — `lib/campaign-recipients.ts`: `RecipientInput.source` + `insertManualRecipients()`; `POST /api/campaigns` applies `manualInsert`; create-modal “Insert a test recipient” (top / after position N / every N).
- **Item 4** — Independent `subjects`/`bodies` rotation (cross-combined per recipient, single-item list held constant), stored per item via `resolvedSubject`/`resolvedBodyHtml`. Updated: `lib/campaign-recipients.ts` `buildQueueItemRows`, `lib/campaign-create.ts`, `POST /api/campaigns`, `[id]/recipients/from-leads/route.ts` (now supports decoupled), `[id]/test-send/route.ts` (synthesizes a probe from lists), the drain render, and the create-modal multi-body editor. The legacy `CampaignVariant` pair path is preserved so automation template cloning still works.
- **Item 5** — `SeedMailbox.userId`; `lib/seed-mailbox.ts` `resolveSeedMailbox(userId)` (own active row, else platform default); new `app/api/test-mailboxes/route.ts` (GET / POST / DELETE) with encrypted passwords; test-send route uses the per-user seed.
- **Item 6** — `lib/imap.ts` `pollSeedMailbox` is spam-aware (`\Junk` SPECIAL-USE via `client.list()`, literal “Spam”/“Junk”… fallback, “unknown” when undetectable) returning `{ found, landedIn, messages, error }`; `runTestSend` threads `landedIn` through; `probeCampaignPlacement()` added; `app/api/internal/mail-queue-drain/route.ts` has the **batch gate** (per-campaign `batchSize` cap per tick, post-batch probe, pauses to `paused_deliverability`, emails the owner, skips until decided); new `app/api/campaigns/[id]/deliverability-decision/route.ts` (continue / switch_subject / stop). Status badges + `landedIn` type added to the campaigns + detail pages.

### ✅ Done — remaining UI (this pass, 2026-09-13)
- **Item 1 — `app/dashboard/campaigns/[id]/page.tsx`** (all four):
  - `paused_deliverability` decision banner (Continue anyway / Switch subject & resume / Stop) wired to the existing `deliverabilityDecision()`/`debating` state.
  - `landedIn` surfaced on the latest-check line (green "inbox" / amber otherwise).
  - `item.source === "manual_insert"` queue rows get a violet “Test” badge; decoupled items show their `resolvedSubject`.
  - `batchSize` shown beside “Rotate every N” (uses `campaign.rotateEvery`/`campaign.batchSize` from the GET row).
- **Item 2 — `components/mailboxes-panel.tsx`**: added a “Deliverability test mailbox” section — lists the user's registered test boxes (GET `/api/test-mailboxes`), a label/host/port/username/app-password form that POSTs to create/update, per-row Delete via DELETE, and a note that none registered = platform default. Test-box loading folds into the existing `load()` so no extra effect was added.
- **Item 3 — create-campaign modal (`app/dashboard/campaigns/page.tsx`)**: added a “Batch size for deliverability checks” number input (default 50, clamped [1,1000]) sent as `batchSize`; `POST /api/campaigns` now accepts it and threads it into `createCampaign()` which stores it on the `EmailCampaign` row.
- **Item 4 — run-detail `app/dashboard/automations/[id]/runs/[runId]/page.tsx`**: added a “Recipients” roster (from `GET …/runs/[runId]`, capped at 500) and labels `source === "manual_insert"` rows with a violet “Test” badge; the run GET route now returns `roster` (the campaign's `EmailQueueItem` toEmail/source/status).
- **Verification (item 5)**: `npx tsc --noEmit` clean; `npm run build` PASSES (exit 0). `npm run lint` is NOT fully clean, but every remaining error is pre-existing codebase-wide debt (the React 19 `react-hooks/set-state-in-effect` pattern used by essentially every page — `clock.tsx`, `admin-panel.tsx`, `extract/page.tsx`, etc. all share it) — this pass **introduced zero new lint errors** and removed several (fixed the `react/no-unescaped-entities` copy, the unused `Prisma` import + `prefer-const` in `lib/campaign-create.ts`, and an unused eslint-disable).

### ❗ Remaining work — NONE implementation-side. Live verification only:
- The ONLY remaining item is the **mandatory LIVE verification** below. It cannot be run in this sandbox (needs real Gmail/IMAP creds), so the code is reviewed + built but NOT live-verified here.

### ❗ Needs real live verification (mandatory, doc's bar)
- **Item 2 live**: upload a list → open Automations without a page reload → list appears; 2+ selected lists merge (deduped) in a run.
- **Item 6 live against a real Gmail test mailbox**: deliberately trigger spam-filtering so the probe's `landedIn` returns `"spam"` (not just `"inbox"` on a clean test); confirm the `"unknown"` → human-check pause path; confirm a decoupled campaign drains via `resolvedSubject`/`resolvedBodyHtml` and that the batch gate pauses + resumes via `deliverability-decision`. **Requires real IMAP/SMTP creds (`SEED_MAILBOX_*` env or a `POST /api/test-mailboxes` row) — not possible in this sandbox, so the spam-detection code is reviewed but NOT live-verified.**

---

## PROMPT FOR NEXT AGENT

Task 29's implementation is **complete** (schema + backend + all UI, including the previously-open remaining-work items) in `/Users/mikeolab/spaceworker` (Next.js 16 + Prisma 6 + postgres on `127.0.0.1:5432`). `npx tsc --noEmit` is clean and `npm run build` passes; the two migrations are applied via **`npx prisma migrate deploy` + `npx prisma generate`** (do NOT use `migrate dev` — the local role can't create a shadow DB, P3014).

The only remaining step is the **mandatory LIVE verification** below. It requires real Gmail/IMAP creds you can't fabricate (`SEED_MAILBOX_*` env or a `POST /api/test-mailboxes` row), so it cannot be done from this sandbox:

- Item 2: upload a list → open Automations without a full page reload → the list appears (the `refreshUploadJobs()` on modal-open fix); select 2+ lists → run merges them deduped by email.
- Item 6: send against a real Gmail test mailbox and deliberately trigger spam-filtering so the probe's `landedIn` returns `"spam"` (not just `"inbox"` on a clean test); confirm the `"unknown"` → human-check pause path; confirm a decoupled campaign drains via `resolvedSubject`/`resolvedBodyHtml` and that the batch gate pauses to `paused_deliverability` and resumes via `deliverability-decision` (continue / switch_subject / stop).

When running the live checks, call the stop / not done until the real Gmail spam placement passes. Report per-item. `npm run lint` is not fully clean due to pre-existing React 19 `react-hooks/set-state-in-effect` debt across many untouched pages; don't chase that unless asked — it predates Task 29 and this pass added zero new findings. Do not re-run `prisma migrate dev` — always `migrate deploy`.
