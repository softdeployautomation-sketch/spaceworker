# Task 9 — Verify Mailbox + Campaign Flows: Verification Report

**Date**: 2026-04-09  ·  **Repo**: `/Users/mikeolab/spaceworker` (branch `main` @ `21e1d56`)

## Verdict

**Solid enough for the campaign-automation work to build on.** No correctness bug was
found in the current single-mailbox paste-recipients send/drain path. Two
flagged-but-not-fixed (defensible/structural) items noted at the bottom. Full
context in the "What I could not test" section — live delivery against a real
provider could not be exercised from this environment, so that one caveat stays
open.

## Method

- Read the *real* shape: `prisma/schema.prisma` (Mailbox / EmailCampaign /
  EmailQueueItem), every route under `app/api/mailboxes`, `app/api/campaigns`,
  `app/api/internal/mail-queue-drain`, the three dashboard pages, and the libs
  (`mailbox-crypto.ts`, `mailbox-safe-select.ts`, `session.ts`, `prisma.ts`).
- Verified nodemailer 9.1.1's actual behavior from source
  (`node_modules/nodemailer/lib/smtp-transport/index.js`, `lib/mailer/index.js`).
- Ran a clean `npm run build` → **exit 0**. The whole route set compiles and
  ships; the mailbox flow is not broken at the build/deploy level.

---

## Area 1 — Add mailbox, encryption at rest, test connection

**Tested: static + build.** Finding: **working as expected.**

- **Encrypted at rest.** `lib/mailbox-crypto.ts` uses AES-256-GCM
  (`createCipheriv("aes-256-gcm", …)`), a fresh random 12-byte IV per row, and
  stores `encryptedPassword` (ciphertext) + `passwordIv` + `passwordTag` — the
  GCM auth tag means tampered data fails decryption rather than decrypting to
  garbage. The raw column is never plaintext. (`POST /api/mailboxes` writes
  exactly this.)
- **No API/UI echo of the secret.** `lib/mailbox-safe-select.ts` explicitly
  excludes `encryptedPassword/passwordIv/passwordTag`, and it is used by every
  mailbox read/write (`GET`/`POST /api/mailboxes`, `PUT /api/mailboxes/[id]`).
  The test route reads the ciphertext only server-side. No route returns any
  password material, including in error branches.
- **Test connection genuinely validates credentials.** `app/api/mailboxes/[id]/test/route.ts`
  builds `nodemailer.createTransport({…})` and awaits `transport.verify()`. I read
  nodemailer 9.1.1's `verify()` (smtp-transport index.js:304-415): it connects,
  EHLOs, and — when the server advertises AUTH and creds are present — calls
  `connection.login(...)`, invoking `callback(err)` on auth failure. So:
  - correct host/port/user/password → `lastTestOk = true`,
  - deliberately-wrong password → SMTP login error → `ok=false` + message (not
    swallowed), `lastTestOk=false`.
  Both `lastTestOk`/`lastTestedAt` are persisted on every attempt.

## Area 2 — Create campaign + queue items + send trigger

**Tested: static + build.** Finding: **working as expected.**

- `POST /api/campaigns` runs `$transaction`: creates the campaign, then
  `createMany`s one `EmailQueueItem` per recipient, each correctly linked to
  both `campaignId` and the chosen `mailboxId`. It also verifies the mailbox
  belongs to the caller (`where: { id, userId }`) before queueing — a foreign
  mailbox reference is rejected.
- `POST /api/campaigns/[id]/send` guards ownership, rejects non-`draft`
  campaigns, and flips status `draft → sending`. The drain only selects items
  whose campaign is `sending`, so queuing and triggering stay cleanly separate.

## Area 3 — Drain: delivery, daily cap, day-rollover, jitter, bounce handling

**Tested: static + build.** Finding: **working as expected**, with caveats.

- **Daily cap enforced.** The drain computes `remaining = dailyLimit - sentToday`
  per mailbox and `take: remaining`, so it never selects more than the day's
  budget. `sentToday` is incremented per successful send and (correctly)
  **not** incremented on failure — a bounce doesn't eat the daily budget. One
  maxed-out mailbox `continue`s without blocking other mailboxes (the loop is
  per-mailbox).
- **Jitter is real, not just configured.** `Math.random() * 40_000 + 5_000` →
  a 5–45s `sleep` before every send inside the batch. Consecutive sends from one
  mailbox are spaced, not a tight loop.
- **Bounce/error handling.** `transport.sendMail(...)` failure marks the item
  `failed` with the error string; the campaign-detail page exposes it via the
  "View" toggle (`status: "failed"` row). Not silently marked sent. Transport
  build failure (e.g. decrypt error) fails the whole fetched sub-batch cleanly.
- **Campaign completion.** Once a mailbox's batch is drained, any touched
  campaign with zero remaining `queued` items flips `sending → done` (all-sent
  or all-failed both qualify, matching Task 4's design).

---

### Caveats / not fixed here (flagging, not patching)
1. **`day` is defined in UTC.** `new Date().toISOString().slice(0,10)` in the
   drain (and nowhere else relevant). The cap is never exceeded — a real
   off-by-one that would *over*-send isn't present — but "today" resets at UTC
   midnight, i.e. ~5–8pm ET for a US sender. That is a product decision (pick a
   business-timezone budget), not a correctness bug; I left it alone rather than
   invent a timezone policy unprompted.
2. **No per-item retry.** A transient SMTP failure is terminal for that item.
   Task 4's design specified no retry, so this is scoped out, but worth knowing.
3. **Concurrent-drain double-send race (real, low-probability).** Selection is a
   plain `findMany({ status: "queued" })` with no atomic claim. Two
   `POST /api/internal/mail-queue-drain` calls overlapping in the same minute
   (e.g. systemd timer + a manual trigger, which Task 9 itself instructs) can
   both select and send the same queued items twice. The default single-timer
   deployment is safe. A proper fix is an atomic
   `UPDATE … SET status='sending' … RETURNING`-style claim with re-queue-on-crash
   semantics — a structural change I could not verify without a live DB, so I
   did not refactor the working single-path flow. Recommended to address before
   the automation work leans on it, but not a blocker for current behavior.

## Area 4 — Tenant isolation (the standing #1 regression risk)

**Tested: static (per-route `where` audit).** Finding: **working as expected.**

Audited every route against `{ userId: session.userId }`:

| Route | Ownership guard |
|---|---|
| `GET /api/mailboxes` | `where: { userId }` |
| `GET/PUT/DELETE /api/mailboxes/[id]` | `findFirst({ where: { id, userId } })` → 404 |
| `POST /api/mailboxes/[id]/test` | `findFirst({ where: { id, userId } })` → 404 |
| `GET /api/campaigns` | `where: { userId }` |
| `GET /api/campaigns/[id]` | `findFirst({ where: { id, userId } })` → 404 |
| `POST /api/campaigns/[id]/send` | `findFirst({ where: { id, userId } })` → 404 |
| `POST /api/campaigns` | campaign is created under caller's `userId`; mailbox must be caller's too |

No route retrieves/returns another user's mailbox or campaign under any
circumstance (not just at the UI layer).

---

## What I could NOT test (state it plainly)

This environment (a Mac work laptop) has **no running PostgreSQL** (migrate
reports P1001), **no Docker**, no reachable deployed SpaceWorker server, and
**no SMTP mailbox I control** / throwaway provider inboxes. Therefore I could
not literally execute the live loop — real external SMTP delivery, the cap under
real load, and the day-rollover against the real clock were verified from the
code path and a clean build, **not** from live sends. The one thing that still
deserves a real run before mass-sending relies on it is **live provider
delivery** (nodemailer `sendMail` resolving only proves SMTP acceptance, exactly
the caveat Task 4 itself called out). Run Areas 1–4 against a throwaway
Gmail/app-password mailbox + 2–3 test inboxes once a DB is available — the
mechanics above say it will hold.