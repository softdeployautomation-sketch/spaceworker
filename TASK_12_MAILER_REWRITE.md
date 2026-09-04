# Cline Task 12 — Mailer Rewrite: CSV Recipients, Real Sender + Subject Rotation, Test-Send-Confirm

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: Prisma schema + app code + one new small operational dependency (a seed mailbox for test-send-confirm).

**Design reference**: a Claude Design canvas covers `MailerApp.dc.html` (sender + subject rotation chips). Ask the user for the current canvas link if you don't have it.

Independent of `TASK_10_OS_DESKTOP_AND_BROWSER.md` and `TASK_11_LEAD_EXTRACTOR_TEMPLATES.md` — no shared files, can run in parallel with a different person on each. Read `PLAN.md` Addendum 2 §4/§5 and Addendum 6 in full before starting — the research and the priority tiering are already worked out there, don't re-derive it.

## Correction to a previous claim — read this first

An earlier version of this task (the old, now-deleted combined `TASK_11_LEAD_EXTRACTOR_AND_MAILER.md`) stated "sender rotation already exists" for the Mailer. **That was wrong.** The real current state, confirmed by reading the live schema and drain route:

- `EmailCampaign` has one fixed `subject`/`bodyHtml` pair (no variants).
- `EmailQueueItem.mailboxId` is set **once, per item, at campaign-creation time** (`POST /api/campaigns` takes a single `mailboxId?: string`) — there is no rotation at all, not even the "sequential multi-run" model `PLAN.md` describes as a baseline. The drain route (`app/api/internal/mail-queue-drain/route.ts`) just iterates every active mailbox and sends whatever's already queued against it — the mailbox assignment happened earlier, at creation.
- `toEmails` is a plain `string[]` — no CSV upload, no per-recipient data beyond the email address, no merge variables.

This task builds the real "must have" tier from `PLAN.md` Addendum 2 §4's priority table, which is genuinely new backend work, not a UI-only pass.

## What to build (Addendum 2 §4's "must have" tier, in full)

### 1. CSV recipient list with merge variables

Replace `toEmails: string[]` with a CSV upload flow: parse the file, first row as headers, one required `email` column, any other columns become per-recipient merge variables (first name, company, etc.) available in the template as `{{firstName}}`-style placeholders. Store per-recipient variable data on `EmailQueueItem` (new `variables: Json` column). Render/replace placeholders in both `subject` and `bodyHtml` at send time, not at queue time (so a later template edit — if ever added — wouldn't require re-parsing the CSV).

### 2. `CampaignVariant` model — subject/body rotation

```prisma
model CampaignVariant {
  id         String        @id @default(cuid())
  campaignId String
  campaign   EmailCampaign @relation(fields: [campaignId], references: [id])
  subject    String
  bodyHtml   String
  createdAt  DateTime      @default(now())

  @@index([campaignId])
}
```
`EmailCampaign`'s single `subject`/`bodyHtml` fields are replaced by a collection of 1+ `CampaignVariant` rows (a campaign with only one variant behaves exactly like today). UI: match `MailerApp.dc.html`'s "Subject lines (rotates evenly)" section — add/remove chips, each chip pairing a subject with a body (or reuse one shared body with only the subject varying, if that's simpler for v1 — decide and note which).

### 3. True sender rotation within a single run

`EmailCampaign` needs a `mailboxIds: String[]` (or a join table, your call) recording which of the user's mailboxes are in this campaign's rotation — a real multi-select at campaign-creation time, replacing the single `mailboxId` field. At send time (queue-creation or drain time — pick one and note it), assign each `EmailQueueItem` a mailbox by round-robin (or random) across the selected set, respecting each mailbox's existing `dailyLimit`/`sentToday` cap logic already in the drain route — don't bypass that, just change how the mailbox gets picked per item.

### 4. `variantId`/`mailboxId` recorded per queue item

`EmailQueueItem` gets `variantId` (which subject/body it was actually resolved to) alongside the (now rotated, not fixed-at-creation) `mailboxId` — needed for later analysis ("did variant B convert better") and for debugging a specific send.

### 5. Test-send-then-confirm before the first real send (manual-confirm mode only — this task's scope)

Before a campaign's first real send: send one test message (using the campaign's own template/variant) via the connected mailbox to one platform-owned seed mailbox, then poll that seed mailbox via IMAP after a short delay to confirm the message actually arrived (proves the SMTP credentials genuinely deliver — `nodemailer`'s `verify()` only proves the handshake, not that the message lands anywhere). Surface the result to the user and require an explicit "yes, this delivered, proceed" click before the real campaign starts — this is the confirm-mode described in Addendum 2 §4, not the fully-automated variant.

New pieces needed:
- One real seed mailbox account (any provider — Gmail is fine for v1) that SpaceWorker itself owns; credentials stored the same encrypted way `Mailbox` already stores customer credentials (reuse `lib/mailbox-crypto.ts`'s pattern).
- An IMAP client to poll it — check `imapflow` vs `node-imap`'s maintenance status before picking (both are viable, pick whichever looks better-maintained at implementation time).
- A `SeedMailbox` model (even if there's only one row for now — keeps the door open for more) and a `DeliverabilityCheck` model logging each test-send attempt (campaign, seed mailbox, result, timestamp) — mirrors the existing `PaymentVerificationAttempt` audit-trail pattern used elsewhere in this codebase (see Task 5's payment review work).
- `EmailCampaign` gets a new status value, e.g. `pending_test_confirm`, sitting between `draft` and `sending` — the real send/drain route must not process a campaign's queue items until this gate is passed.

## Explicitly not this task (deferred per Addendum 2 §4's own tiering — do not build these here)

- **Checkpoint deliverability monitoring + auto-pause** (the "should have" / Phase 1.5 tier) — ongoing periodic re-checks during a send, `paused_deliverability` status. This task only builds the one-time pre-send test-confirm gate.
- **Bounce/complaint handling** — "should have" tier, separate task.
- **Spintax, open-rate-driven A/B winner selection** — explicitly deferred, nice-to-have tier.
- **Sending-account warmup** — explicitly out of scope per Addendum 2 §4.
- Campaign-template automation (Addendum 4's "mass ads" template, the Automation tab) — still blocked on this task plus Task 9 (mailbox/campaign E2E verification) being done first, per the plan's own stated sequencing. This task is a prerequisite for that, not that work itself.
- Lead Extractor templates — that's `TASK_11_LEAD_EXTRACTOR_TEMPLATES.md`, a separate task.
- The desktop/dock shell and Browser app — that's `TASK_10_OS_DESKTOP_AND_BROWSER.md`.

## Verification

1. Upload a CSV with `email, firstName, company` columns, create a campaign referencing `{{firstName}}` in the subject, send to a small real test list, confirm each recipient's actual received email has their own name substituted, not a literal `{{firstName}}` or someone else's.
2. Create a campaign with 2+ subject/body variants and 2+ mailboxes selected, run a real small send, confirm both variant and mailbox actually rotate across recipients (check `EmailQueueItem.variantId`/`mailboxId` after sending, don't just trust the UI state) — and confirm each mailbox's existing `dailyLimit` cap is still respected.
3. Create a campaign, confirm it cannot send until the test-send-confirm step completes; confirm the test message actually arrives at the seed mailbox and is detected via the IMAP poll; confirm clicking "confirm, proceed" is what unlocks the real send (not, e.g., a timer or an assumption).
