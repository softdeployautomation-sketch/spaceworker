# PROMPT — VERIFICATION AGENT for TASK_187 (payment-alert email + support notifications + support invoice composer)

TASK_187 implementation is expected to be COMPLETE when you run. Your job: independently
verify it and close it out — or FAIL it loudly with repro steps. Sources of truth:
**`TASK_187_PAYMENT_ALERTS_INVOICE.md`** (scope S1–S5, owner's verbatim words) and the
implementer's **`TASK_187_STEPS.md`** (their tracker — MUST exist with every step checked
+ evidence; missing/incomplete = FAIL and report). Playbook (binding):
`HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4/§6 live evidence). NEVER git stash;
never edit `.env`; never touch TASK_133; REJECT any commit/doc containing live secrets;
money/invoice commits must be separate from UI commits — check `git log` for that.

Start: `git log --oneline -8` in `/Users/mikeolab/spaceworker`. Record
`git rev-parse HEAD`. Everything of TASK_187 must be after the TASK_185 steps commit
`62ffb3e`.

## 1. S1 — payment alert email actually arrives
- `grep -n "notifyAdminPendingPayment" app/api/billing/submit/route.ts
  app/api/billing/topup/route.ts` → still 3+ call sites (nothing regressed).
- On the box (read-only): `NotificationLog` has recent `admin_pending_payment` rows
  with `outcome:"sent"`; resolve what `env.adminEmail` points to — if the fix was
  config, the OWNER must have confirmed receiving a real alert email. If the implementer
  changed code, review `lib/payment-notify.ts` diff for: still fire-and-forget, still
  best-effort (never throws into the route), Telegram path untouched.
- Live trigger (house harness pattern, DELETE the harness from the box after): submit a
  no-hash pending payment → owner receives **BOTH** Telegram and email. Ask owner to
  eyeball the email = final evidence.

## 2. S2 — support notifications both directions
- Code review: new-ticket POST (`app/api/support/tickets`) → admin Telegram + email;
  admin reply (`app/api/admin/support/tickets/[id]/messages`) → user email. Both via
  the shared pattern, wrapped so a notify failure can never fail the HTTP request
  (grep for try/catch or void+promise discipline; find a test that proves it).
- Static: `grep -rn "notifyAdmin\|sendEmail" app/api/support lib/support-notify.ts
  lib/payment-notify.ts` shows the wiring; NotificationLog rows appear for a test
  ticket create + reply.
- Live: create a test ticket (box harness or owner) → owner gets Telegram + email;
  admin reply → user email received (owner/test inbox).

## 3. S3/S4 — support invoice composer + user pays from the ticket
- `npx prisma migrate diff` or schema grep: `PremiumInvoice.days Int?` exists +
  `invoiceId` on the support message model; migration + lock file committed.
- UI (chunk grep of the built client): support panel contains the plan dropdown
  (Premium Plus / Premium XDevice), amount input, optional duration field, and
  "Send invoice"; methods override field present (manual payment details per invoice).
- e2e with a test account: request → ticket flagged → admin composes invoice
  (amount + optional days + custom or default methods) → invoice card visible IN the
  thread + user email arrives with Pay button → `/dashboard/billing` shows the invoice
  with its methods → user submits payment with `invoiceId` → admin approval → invoice
  `paid`, tier granted, duration applied when set. **No duration/term string rendered
  to the user anywhere** (grep billing/thread for day/term strings in user-facing copy).
- Tests: `npm run test:invoice` + `npm run test:support` green with the NEW cases
  (notify wiring, duration-on-settle, methods override, thread render).

## 4. REGRESSIONS + DEPLOY-STATE
- `npx tsc --noEmit` → 0; ESLint touched files → 0 NEW (stash A/B; admin-panel
  pre-existing errors are not theirs).
- Suites: `test:xdevice` 38 · `test:wallet` 63 · `test:module-gate` · `test:devices` 6 ·
  `test:wrapper-cookie` 6 · `test:maintenance-cache` 6 · `test:invoice` · `test:support`.
- Prior tasks intact: TASK_184 web locks (live 403), TASK_185 P1/P2 (no "activity
  unknown", honest counts), TASK_186 (payment-notify on all billing paths), TASK_183
  wrapper ($500 card still in wrapper branch — grep client chunk), joker page on
  spaceworker.instaweb.top root only (deep paths proxy to app).
- Deploy-state: fresh BUILD_ID, service active, site 200, repo↔box md5 parity on
  touched files, secrets scan over new commits (placeholders only).

## 5. HANDOFF + REPORT
- Check off / append evidence in `TASK_187_STEPS.md`; mark TASK_187 S1–S5 complete;
  refresh `SENIOR_HANDOFF.md` §6; REWRITE THIS PROMPT for the next verifier; commit
  with explicit messages; push.
- Report: PASS/FAIL table over §1–§3, regression output, deploy evidence (BUILD_ID,
  chunk greps, NotificationLog rows), and an OPENLY UNVERIFIED list (browser clicks,
  owner inbox items awaiting owner confirmation).