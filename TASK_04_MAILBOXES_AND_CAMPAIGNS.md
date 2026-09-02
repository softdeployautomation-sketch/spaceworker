# SpaceWorker Task 4 — Mailboxes + Email Campaigns

**Assigned to Michael.** This task is deliberately scoped to be self-contained: it depends only on Task 1 (the `User` model, auth/session, and the Next.js app shell existing) — nothing here touches Task 2's Python worker or Task 3's queue/lanes. You can build this in parallel with that other work once Task 1 has landed on `main`.

**Read `PLAN.md` first** (in the repo root) for full product context — you don't need the whole thing memorized, but the "Why BYO SMTP is mandatory" section explains why this whole feature exists the way it does, and is worth reading before writing any code.

## What this is, in one paragraph

Customers connect their own SMTP mailbox(es) (their own email accounts, their own domain — e.g. `admin@theirdomain.com`, `contact@theirdomain.com`, both genuinely theirs) to send outreach emails to leads they've extracted (Task 2/3's job — not something this task needs to touch). This product deliberately never sends through its own email infrastructure for this — see "Why BYO SMTP" in `PLAN.md`: every major transactional email provider (SendGrid, Mailgun, Resend included) bans cold outreach in their terms of service and will suspend an account for it. So the customer's own mailbox carries their own reputation risk, and this feature's whole job is managing that safely: encrypting their credentials at rest, testing the connection before trusting it, and enforcing sane sending limits so nobody's mailbox gets themselves blacklisted through this tool.

**A campaign can have multiple runs, each with its own real mailbox and settings** — a customer might send Run 1 from `admin@` with one template and pacing, then Run 2 from `contact@` with a different template and pacing, entirely deliberately, because both are genuinely their own addresses used for different purposes. **This is not identity rotation or disguise** — every run's `fromMailboxId` points at a real, connection-tested `Mailbox` the customer owns, and the point of multiple runs is giving them normal campaign flexibility (different subject/copy/pace per run), not making the traffic look different to a spam filter. Don't build anything that picks a sender or subject automatically "to vary the pattern" — every choice of mailbox/template/pacing per run is the customer's own explicit configuration.

## Prisma schema

```prisma
model Mailbox {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id])
  label         String   // customer-chosen name, e.g. "Sales outreach"
  host          String
  port          Int
  username      String
  encryptedPassword String // AES-256-GCM ciphertext — see below, NEVER store plaintext
  passwordIv    String   // the GCM IV/nonce used for this row, stored alongside the ciphertext
  passwordTag   String   // the GCM auth tag
  secure        Boolean  @default(true) // TLS on connect
  dailyLimit    Int      @default(40)   // matches the extractor's own existing "30-50/day" safe-volume finding
  sentToday     Int      @default(0)
  sentTodayDate String?  // "YYYY-MM-DD" — reset sentToday to 0 when this doesn't match today's date
  active        Boolean  @default(true)
  lastTestedAt  DateTime?
  lastTestOk    Boolean?
  createdAt     DateTime @default(now())

  @@index([userId])
}

model EmailCampaign {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  name        String
  searchJobId String?  // which extraction job's leads this targets overall — nullable FK,
                        // no hard relation needed since Task 3 owns that model; just store the id
  status      String   @default("draft") // "draft" | "running" | "done"
  createdAt   DateTime @default(now())
  runs        CampaignRun[]

  @@index([userId])
}

// A campaign can have multiple runs, executed in order. Each run has its own
// mailbox, subject, body, and pacing — e.g. Run 1 sends from admin@ with one
// template, Run 2 sends from contact@ with a different one, both genuinely
// the customer's own mailboxes. mailboxId is ALWAYS the customer's explicit
// choice for that run — never auto-selected or rotated by the system.
model CampaignRun {
  id               String        @id @default(cuid())
  campaignId       String
  campaign         EmailCampaign @relation(fields: [campaignId], references: [id])
  runOrder         Int           // 1, 2, 3... — runs execute in this order, not concurrently
  mailboxId        String
  mailbox          Mailbox       @relation(fields: [mailboxId], references: [id])
  subject          String
  bodyHtml         String
  pacingSecondsMin Int           @default(20) // jitter floor between sends in this run
  pacingSecondsMax Int           @default(90) // jitter ceiling between sends in this run
  status           String        @default("draft") // "draft" | "queued" | "sending" | "done"
  createdAt        DateTime      @default(now())
  items            EmailQueueItem[]

  @@index([campaignId, runOrder])
}

model EmailQueueItem {
  id            String      @id @default(cuid())
  campaignRunId String
  campaignRun   CampaignRun @relation(fields: [campaignRunId], references: [id])
  toEmail       String
  status        String      @default("queued") // "queued" | "sent" | "failed"
  sentAt        DateTime?
  error         String?
  createdAt     DateTime    @default(now())

  @@index([campaignRunId, status])
}
```
Add `mailboxes Mailbox[]`, `emailCampaigns EmailCampaign[]` to `User`, and `campaignRuns CampaignRun[]` to `Mailbox`.

## Encryption at rest — the part that matters most in this task

**SMTP passwords must never be stored in plaintext, and must never appear in a server log.** Use Node's built-in `crypto` module, AES-256-GCM:

```ts
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const KEY = Buffer.from(process.env.MAILBOX_ENCRYPTION_KEY!, "hex"); // 32 bytes, generate once with `openssl rand -hex 32`, never commit it

export function encryptSecret(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

export function decryptSecret(ciphertext: string, iv: string, tag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]).toString("utf8");
}
```
Put this in a `lib/mailbox-crypto.ts` with `import "server-only"` at the top. `MAILBOX_ENCRYPTION_KEY` is a new env var — 32 random bytes, hex-encoded, generated once and treated as seriously as any other production secret (never logged, never returned from any API response, never committed).

**Never return `encryptedPassword`/`passwordIv`/`passwordTag` from any API route** — when listing a user's mailboxes, return everything except those three fields. Decrypt only at the exact moment of connecting to send mail, in memory, never persisted decrypted anywhere.

## Routes

- `app/api/mailboxes/route.ts` — `GET` (list, minus the encrypted fields), `POST` (create: validate + encrypt the password immediately, never hold it in a variable longer than needed).
- `app/api/mailboxes/[id]/test/route.ts` — `POST`: decrypt the stored credentials, attempt a real SMTP connection + auth (nodemailer's `transporter.verify()` is exactly built for this — use it, don't roll your own SMTP handshake), update `lastTestedAt`/`lastTestOk`, return the result. **Do not send a test email** — `verify()` only checks the connection/auth handshake, which is what you want here (no need to actually deliver mail to prove credentials work).
- `app/api/campaigns/route.ts` — `GET`/`POST` (create a campaign, empty of runs initially).
- `app/api/campaigns/[id]/runs/route.ts` — `POST`: add a run to a campaign — `{ mailboxId, subject, bodyHtml, toEmails: string[], pacingSecondsMin?, pacingSecondsMax? }`. Validates `mailboxId` belongs to the caller (same ownership discipline as everywhere else — never trust a client-supplied ID without checking), creates the `CampaignRun` + its `EmailQueueItem` rows from the given `toEmails` list (Task 3 owns fetching "leads from job X" — this route just accepts whatever email list it's given).
- `app/api/campaigns/[id]/send/route.ts` — `POST`: flips the campaign to `status: "running"` and its first (`runOrder: 1`) run to `queued`; actual sending is the queue-drain worker below, not this route (this route shouldn't block on sending hundreds of emails synchronously). **Runs execute in order** — the drain only works on the lowest `runOrder` run that isn't yet `done`; it doesn't start Run 2's items until Run 1's are all `sent`/`failed`.

## The send-queue drain (systemd timer, same pattern as everywhere else in this project)

A script/route (`app/api/internal/mail-queue-drain/route.ts`, bearer-token gated like every other internal route in this project) that runs every minute or so via a systemd timer:
1. For each campaign with `status: "running"`, find its lowest-`runOrder` `CampaignRun` that isn't `done`. If all that run's items are `sent`/`failed`, mark it `done` and advance the campaign to its next run (or mark the whole campaign `done` if that was the last run).
2. For each such active run: check its `Mailbox` has `active: true` and `sentToday < dailyLimit` (reset `sentToday` to 0 first if `sentTodayDate` isn't today), then pull up to a small batch of that run's `queued` `EmailQueueItem`s.
3. For each item: decrypt the mailbox's credentials, send via `nodemailer.createTransport(...)` using **that run's own `subject`/`bodyHtml`**, **add jitter between sends using that run's own `pacingSecondsMin`/`pacingSecondsMax`** (don't fire a batch back-to-back — this is exactly what the original Python `rate_limiter.py` already modeled, per `PLAN.md`; reimplement that same spirit in TypeScript).
4. On success: mark the item `sent`, increment the mailbox's `sentToday`. On failure: mark `failed`, store the error, **do not increment `sentToday`** (a bounced/failed send shouldn't count against the mailbox's daily budget).
5. Stop processing a given mailbox once it hits `dailyLimit` for the day — don't let one mailbox's backlog starve others, and don't let a maxed-out mailbox block a *different* run that uses a different mailbox.

## Verification

1. Add a mailbox with real (or a disposable test) SMTP credentials; confirm the test-connection button genuinely succeeds/fails correctly (test with an intentionally wrong password too — must fail cleanly, not throw an unhandled error).
2. Confirm `encryptedPassword` never appears in any API response, ever, including error responses.
3. Create a campaign with two runs (different mailboxes, different subjects/templates), queue a handful of sends on each, run the drain manually; confirm Run 1 fully completes (all its items `sent`/`failed`) before Run 2's items are ever picked up, confirm jitter is actually happening (timestamps between sends aren't identical/instant) and each run's own pacing settings are respected, and confirm the daily cap is enforced per-mailbox (queue more than `dailyLimit` items on one run, confirm only `dailyLimit` actually send today from that mailbox).
4. Confirm a failed send doesn't count against the daily cap, and confirm its error message is visible somewhere the customer can see it (not just swallowed).
5. Confirm a maxed-out mailbox on one run doesn't block a different run on a different mailbox within the same drain cycle.
6. Two different users' mailboxes and campaigns never appear in each other's lists — standard tenant-isolation check.

## Repo access

You'll get a `michael-dev` branch on the `spaceworker` GitHub repo (private, general-purpose — not tied to just this one task, future tasks assigned to you will also branch from/land on it) — push there, open a PR to `main` when ready. **Note on `main` protection**: GitHub's branch-protection rules require a paid plan on a private repo, which this account doesn't have, so there's no technical block on pushing straight to `main` — treat the PR-review process as a hard rule anyway, just enforced by discipline rather than the platform. Ask the user (not Claude) for anything about product direction; ping Claude if you hit something that looks like it needs a decision about the shared schema/conventions from Task 1.
