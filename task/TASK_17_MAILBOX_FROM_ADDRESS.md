# Task 17 — Decouple a Mailbox's SMTP login from its From address

**Status: ready to implement.** Written 2026-09-08 so the user can add `noreply@instaweb.top`, `admin@instaweb.top`, and `support@instaweb.top` as three separate sending `Mailbox` rows (all via Resend's SMTP relay, all on the domain already proven to deliver — see Task 16's sibling fix, `RESEND_API_KEY` in `.env` is now a real, working key) and manually test sender + subject rotation against a real inbox before any campaign touches real leads.

## The bug this fixes

Confirmed by reading the code, not assumed: **`Mailbox.username` is used for two different jobs that happen to be the same value for a normal mailbox, but aren't for a relay service like Resend.**

- `lib/mailer-send.ts`'s `transporterForMailbox()` passes `mailbox.username` as the SMTP **auth username**.
- `lib/deliverability.ts` (`from: opts.mailbox.username`) and `app/api/internal/mail-queue-drain/route.ts` (`from: mailbox.username`) both also use it as the **From address** on the actual sent message.

For a real personal/business mailbox (Gmail, Comcast, a real Zoho inbox), the SMTP login and the From address genuinely are the same email address, so this has never been a problem. **Resend's SMTP relay breaks that assumption**: confirmed against Resend's own docs — the SMTP login username must be the literal string `"resend"` (password = the API key), completely independent of which verified address you actually send *as*. So today, a `Mailbox` row can't represent "log in as `resend`, but send as `admin@instaweb.top`" at all — whichever value you put in `username` has to serve both jobs, and for Resend those two values are never the same.

## The fix

### 1. Schema

```prisma
model Mailbox {
  // ...existing fields unchanged...
  username     String  // SMTP AUTH username only, going forward
  fromAddress  String? // NEW — the address mail is actually sent as. Nullable:
                        // null means "same as username" (every existing mailbox's
                        // real-world behavior, unchanged) so this is purely additive.
}
```

Migration: `npx prisma migrate dev --name add_mailbox_from_address` (or the deploy-time equivalent this repo uses) — one nullable column, no backfill needed since `null` already means "behave exactly as today."

### 2. The two send call sites

Both currently do `from: mailbox.username`. Change both to:

```ts
from: mailbox.fromAddress || mailbox.username,
```

- `lib/deliverability.ts` line ~45
- `app/api/internal/mail-queue-drain/route.ts` line ~81

That's the entire behavioral fix — everything else (rotation logic, daily caps, the test-send-confirm gate) is untouched and already correct.

### 3. UI (`app/dashboard/mailboxes/page.tsx`)

Add one optional field to the add/edit mailbox form: **"From address (optional)"**, with helper text along the lines of *"Leave blank for a normal email account — most providers send as whichever address you log in with. Only needed for a relay service like Resend, where you log in as a fixed account but want to send as a specific address."* Persist it as `fromAddress` in the existing `save()` POST/PUT payload (mirrors exactly how `password` is already conditionally included only when non-empty).

### 4. API routes (`app/api/mailboxes/route.ts`, `app/api/mailboxes/[id]/route.ts`)

Accept an optional `fromAddress` in the POST/PUT body (trimmed, empty string treated as `null`/unset — don't store `""`), include it in `MAILBOX_SAFE_SELECT` (it's not a secret, unlike the password fields, so it's fine to return as-is in every mailbox response).

## How this gets used (context, not part of the code change)

Once this lands, the user will manually add three `Mailbox` rows, all pointing at `smtp.resend.com` (port 587, secure/TLS), all with `username: "resend"` and `password: <the Resend API key>`, differing only in `fromAddress`:

| label | fromAddress |
|---|---|
| noreply | noreply@instaweb.top |
| admin | admin@instaweb.top |
| support | support@instaweb.top |

Then build a small test campaign targeting the user's own inbox to manually verify sender rotation (does each send actually alternate its From address across the three?) and subject rotation (do the `CampaignVariant` subjects rotate too?) before ever pointing a real campaign at real leads.

## Explicitly out of scope for this task

- The seed-mailbox multi-provider deliverability check discussed separately (adding more `SeedMailbox` rows, looping the test-send-confirm gate over all active ones) — that's its own task, not bundled here.
- Any validation that `fromAddress`'s domain is actually deliverable/verified with whatever SMTP host is configured — that's exactly what the existing "Test" button (`POST /api/mailboxes/[id]/test`) and the campaign's test-send-confirm gate already exist to catch; this task doesn't add new validation on top.

## Verification

1. `npx prisma generate` + `npx tsc --noEmit` + `npm run build` clean.
2. Add a mailbox with `username: "resend"`, `password: <real Resend API key>`, `host: "smtp.resend.com"`, `port: 587`, `secure: true`, `fromAddress: "admin@instaweb.top"` — click "Test" (existing `nodemailer.verify()` flow) and confirm it reports a successful connection (proves SMTP auth works with the fixed `"resend"` username).
3. Send a real test email through it (via the campaign test-send-confirm flow, or a one-off script) and confirm the received message's From header shows `admin@instaweb.top`, not `resend`.
4. Confirm every EXISTING mailbox (real Gmail/Comcast/etc., `fromAddress` left null) sends exactly as it did before this change — regression check, not just the new path.
