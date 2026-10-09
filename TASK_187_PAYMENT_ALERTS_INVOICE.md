# TASK_187 — Payment-alert EMAIL (both channels) + support notifications + admin invoice composer from support

**Owner's words (verbatim, 2026-10-08):** *"there is a gap in the admin granting users
subscription in our new flow. i just tested, the ticket came in, firstly i need a
notification for every ticket, email and telegram, also i only got the telegram
notification for payment not email, i want both, and for this support i want both too,
and for a request for any sub or whatever, they should be a way i can send invoice of
what i feel like, they should be a template of the price of what the user requested, or
maybe just put the sub options in a dropdown for me in the support, so i can just click
like the premium plus invoice so when i insert like $50 amount, and i can decide to add
duration or not, so when i send that, it goes with our payment flow to the user, the user
gets the invoice in the ticket and an email as well, so they click a button to pay invoice
and it shows the payment method they can choose from. and i can decide to use it this way
by typing the payment details manually, but i want that method added for speed."*

**Extracted from TASK_185 (N1 + N2 there — TASK_185 now only holds P5 + W9).**
**TRACKING (MANDATORY, step 0):** create `TASK_187_STEPS.md` immediately, model it on
`TASK_181_STEPS.md` / `TASK_185_STEPS.md`, update it after EVERY step so a compaction
cannot lose progress. Playbook **HOW_WE_MOVE_FAST.md** is binding (§7 gates → §2/§3
deploy → §4 live evidence). NEVER `git stash`; never edit `.env` by hand (flag it to the
owner); never commit `TASK_133_RMM_ENGINE_BRINGUP.md`; REJECT any commit/doc containing
live secrets (placeholders only); **money/invoice code commits MUST be separate from UI
commits** (house rule).

## WHAT EXISTS ALREADY (do NOT rebuild — read these first)

- `lib/payment-notify.ts` — `notifyAdminPendingPayment()` = the house dual-channel
  pattern (Telegram via `notifyAdmin()` + `sendEmail()` to `env.adminEmail`, fire-and-
  forget, best-effort, NotificationLog written by sendEmail). Wired at
  `app/api/billing/submit/route.ts:201` and `topup/route.ts:156,292`.
- `lib/env.ts:168` — `adminEmail: ADMIN_EMAIL || EMAIL_FROM || ""`.
- `PremiumInvoice` model (`prisma/schema.prisma:3695`) — plan/tier/amountUsd/status/
  **methods Json snapshot**/paidAt; NO duration column yet. House migration naming:
  `prisma/migrations/202611*` pattern + `.md` lock file.
- Admin invoice APIs: `POST|GET /api/admin/users/[id]/invoices` + `PATCH …/[invoiceId]`
  (TASK_184 B3, money — edit only while `status:"open"`). User read:
  `GET /api/billing/invoices` + billing card with Pay block showing the methods snapshot
  (TASK_184 B4, `app/dashboard/billing/page.tsx:172-177,618+`). Settle = existing
  payment submit carrying `invoiceId` → admin approval → invoice paid + tier granted
  (verify the grant on settle, don't duplicate it).
- `components/admin/user-invoice-cell.tsx` — the Users-tab "Send invoice" cell (KEEP it).
- Support: `components/admin/support-queue-panel.tsx` (category dropdown `:116-117`,
  premium-request render `:443`), routes `app/api/support/tickets` + `app/api/admin/
  support/tickets/[id]/messages` (admin reply), `lib/support-templates.ts`
  (`premium_request_plus` / `premium_request_xdevice` labels).
  **ZERO notify calls exist anywhere in support code** — confirmed by grep.
- Tests already present: `test:invoice` (`tests/premium-invoice.test.ts`),
  `test:support` (`tests/support-tickets.test.ts`) — extend, don't fork.


## SCOPE (owner's order)

### S1 — payment alert EMAIL (diagnose BEFORE touching code)
- [x] Live diagnosis on the VPS (read-only): `NotificationLog` rows for
      `admin_pending_payment` — did sendEmail attempt? outcome? If rows exist `sent` →
      Resend delivery log for the recipient. Likely cause: `ADMIN_EMAIL` unset ⇒
      fallback recipient is `spaceworker@instaweb.top` (owner never sees it) — confirm
      with `grep ADMIN_EMAIL /opt/spaceworker/.env` (read-only; NEVER print values) +
      what `env.adminEmail` resolves to.
- [x] Fix per finding: config → flag the needed `.env` line to the OWNER (they apply
      it, then re-verify live); code bug → fix in `lib/payment-notify.ts` / `lib/email.ts`.
      Telegram already works — do not regress it.

### S2 — support notifications (both directions, both channels)
- [x] New ticket opened by a user → owner gets **Telegram + email** (ticket id, user
      email, category, subject, admin URL). Reuse the `notifyAdminPendingPayment`
      pattern — shared helper (e.g. `notifyAdminTicketCreated`) in `lib/payment-notify.ts`
      or `lib/support-notify.ts`; fire-and-forget; a notify failure must NEVER fail the
      ticket POST.
- [x] Admin reply in a thread → the **user gets an email** (`Re: <ticket subject>`,
      link to the ticket/billing page).
- [x] Both directions write NotificationLog (sendEmail does) — best-effort only.

### S3 — admin invoice composer IN THE SUPPORT PANEL
- [x] `support-queue-panel.tsx`, on a selected ticket: **"Send invoice" composer** =
      **plan dropdown** (Premium Plus / Premium XDevice — reuse
      `lib/support-templates.ts` labels; default inferred from a premium-request ticket
      category), **amount input** (prefilled from the configured price; owner types any
      number, validated > 0), **optional duration (days)** — *"i can decide to add
      duration or not"*.
- [x] Schema — ONE migration: `PremiumInvoice.days Int?` + nullable `invoiceId` on the
      support-message model (check actual model name first) so the thread can render
      the invoice card. House migration naming + `.md` lock file.
- [x] Send path REUSES `POST /api/admin/users/[id]/invoices` (never a second money
      path); the composer then posts an admin thread message carrying `invoiceId` so
      **the invoice shows in the ticket thread**.
- [x] **Payment details:** invoice keeps the automatic **methods snapshot** (fast
      default = configured payout addresses, TASK_184 behavior) AND the composer lets
      the admin **hand-type/override payment details** per invoice (methods is Json —
      accept an admin-edited object while composing). Owner picks per invoice.

### S4 — user pays from the ticket/email
- [x] Thread renders the invoice card (plan, amount, status, methods) for the ticket
      owner; the invoice email arrives with a **Pay button → `/dashboard/billing`**
      (card already renders there with methods + submits through the existing flow
      carrying `invoiceId`).
- [x] Verify end-to-end on the EXISTING settle path: submit with `invoiceId` → admin
      approval → invoice `paid` + tier granted. Duration set → grant uses `days`;
      null → current default. **Never render any duration/term string to the user**
      (TASK_181 wording rule stays).

### S5 — gates + deploy (playbook §7/§2)
- [x] `npx tsc --noEmit` → 0. ESLint touched files → 0 NEW (direct per-file runs —
      no stash, house rule; admin-panel pre-existing errors are not yours).
- [x] Tests: `test:invoice` + `test:support` extended (notify on create/reply,
      duration applies on settle, methods override, invoice renders in thread);
      regression battery: `test:xdevice` 38 · `test:wallet` 63 · `test:module-gate`
      13 · `test:wrapper-cookie` 6 (`test:maintenance-cache` does NOT exist —
      corrected 2026-10-08).
- [x] Deploy (`scripts/deploy-vps.sh`): fresh BUILD_ID, service active, site 200,
      repo↔box md5 parity. Live evidence: test ticket + pending payment →
      NotificationLog rows + owner receives BOTH Telegram and email (owner eyeball).

## OUT OF SCOPE
Web prices stay hidden (TASK_184 B1); wrapper $500 card untouched; auto-approved
payments don't ping; Users-tab `UserInvoiceCell` stays (we ADD the support composer);
no new payment rails.

**VERIFICATION:** `PROMPT_VERIFY_TASK_187.md` — owner hands it to the verifier when the
implementer finishes; PASS/FAIL over S1–S5.
