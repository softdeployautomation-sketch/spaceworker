# SpaceWorker Task 4 — Mailboxes + Email Campaigns

**Assigned to Michael.** This task is deliberately scoped to be self-contained: it depends only on Task 1 (the `User` model, auth/session, and the Next.js app shell existing) — nothing here touches Task 2's Python worker or Task 3's queue/lanes. You can build this in parallel with that other work once Task 1 has landed on `main`.

**Read `PLAN.md` first** (in the repo root) for full product context — you don't need the whole thing memorized, but the "Why BYO SMTP is mandatory" section explains why this whole feature exists the way it does, and is worth reading before writing any code.

## What this is, in one paragraph

Customers connect their own SMTP mailbox (their own email account, their own domain) to send outreach emails to leads they've extracted (Task 2/3's job — not something this task needs to touch). This product deliberately never sends through its own email infrastructure for this — see "Why BYO SMTP" in `PLAN.md`: every major transactional email provider (SendGrid, Mailgun, Resend included) bans cold outreach in their terms of service and will suspend an account for it. So the customer's own mailbox carries their own reputation risk, and this feature's whole job is managing that safely: encrypting their credentials at rest, testing the connection before trusting it, and enforcing sane sending limits so nobody's mailbox gets themselves blacklisted through this tool.

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
  subject     String
  bodyHtml    String
  searchJobId String?  // which extraction job's leads this targets — nullable FK, no hard
                        // relation needed here since Task 3 owns that model; just store the id
  status      String   @default("draft") // "draft" | "sending" | "done"
  createdAt   DateTime @default(now())
  items       EmailQueueItem[]

  @@index([userId])
}

model EmailQueueItem {
  id           String        @id @default(cuid())
  campaignId   String
  campaign     EmailCampaign @relation(fields: [campaignId], references: [id])
  mailboxId    String
  mailbox      Mailbox       @relation(fields: [mailboxId], references: [id])
  toEmail      String
  status       String        @default("queued") // "queued" | "sent" | "failed"
  sentAt       DateTime?
  error        String?
  createdAt    DateTime      @default(now())

  @@index([campaignId, status])
  @@index([mailboxId, status])
}
```
Add `mailboxes Mailbox[]`, `emailCampaigns EmailCampaign[]` to `User`, and `queueItems EmailQueueItem[]` to `Mailbox`.

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
- `app/api/campaigns/route.ts` — `GET`/`POST` (create a campaign + its `EmailQueueItem` rows from a list of lead emails the client provides — Task 3 owns fetching "leads from job X," this route just accepts whatever `toEmail` list it's given and doesn't need to know how leads work internally).
- `app/api/campaigns/[id]/send/route.ts` — `POST`: flips the campaign to `status: "sending"`; actual sending is the queue-drain worker below, not this route (this route shouldn't block on sending hundreds of emails synchronously).

## The send-queue drain (systemd timer, same pattern as everywhere else in this project)

A script/route (`app/api/internal/mail-queue-drain/route.ts`, bearer-token gated like every other internal route in this project) that runs every minute or so via a systemd timer:
1. For each `Mailbox` with `active: true` and `sentToday < dailyLimit` (reset `sentToday` to 0 first if `sentTodayDate` isn't today), pull up to a small batch of `queued` `EmailQueueItem`s pointing at that mailbox.
2. For each item: decrypt the mailbox's credentials, send via `nodemailer.createTransport(...)`, **add jitter between sends** (a random delay, a few seconds to a minute — don't fire an entire batch back-to-back; this is exactly what the original Python `rate_limiter.py` already modeled, per `PLAN.md` — reimplement that same spirit in TypeScript, don't skip it because it's "just a delay").
3. On success: mark the item `sent`, increment `sentToday`. On failure: mark `failed`, store the error, **do not increment `sentToday`** (a bounced/failed send shouldn't count against the mailbox's daily budget).
4. Stop processing a given mailbox for this run once it hits `dailyLimit` — don't let one mailbox's backlog starve others.

## Verification

1. Add a mailbox with real (or a disposable test) SMTP credentials; confirm the test-connection button genuinely succeeds/fails correctly (test with an intentionally wrong password too — must fail cleanly, not throw an unhandled error).
2. Confirm `encryptedPassword` never appears in any API response, ever, including error responses.
3. Create a campaign, queue a handful of sends, run the drain manually; confirm jitter is actually happening (check timestamps between sends aren't identical/instant) and confirm the daily cap is enforced (queue more than `dailyLimit` items, confirm only `dailyLimit` actually send today).
4. Confirm a failed send doesn't count against the daily cap, and confirm its error message is visible somewhere the customer can see it (not just swallowed).
5. Two different users' mailboxes and campaigns never appear in each other's lists — standard tenant-isolation check.

## Repo access

You'll get a `mailboxes-dev` branch on the new `spaceworker` GitHub repo (private) — push there, open a PR to `main` when ready. `main` is protected the same way as `vantra-installer`: PR + review required, no direct pushes. Ask the user (not Claude) for anything about product direction; ping Claude if you hit something that looks like it needs a decision about the shared schema/conventions from Task 1.
