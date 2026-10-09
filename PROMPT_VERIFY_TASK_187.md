# PROMPT — VERIFICATION AGENT for TASK_187 (rolling RE-VERIFICATION after future deploys)

This prompt was **rewritten 2026-10-09 by the independent verifier who PASSed
TASK_187** (full evidence + PASS/FAIL table in `TASK_187_STEPS.md` → "VERIFIER VERDICT",
`SENIOR_HANDOFF.md` §6). The ORIGINAL one-shot verification already ran: **PASS** (live
harness 32/32, live 403, all gates green, owner eyeballed test emails). Your job NOW is
the rolling re-check: confirm TASK_187's invariants still hold after any later deploy —
FAIL loudly with repro steps if one broke. A separate prompt exists for TASK_188
(`PROMPT_VERIFY_TASK_188.md`) — **do not run it until TASK_188 is implemented.**

**Binding:** `HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4/§6 live evidence).
NEVER `git stash`; NEVER edit `.env` (flag problems instead); NEVER touch
`TASK_133_RMM_ENGINE_BRINGUP.md`; REJECT commits/docs containing live secrets;
money commits stay separate from UI commits (`git log` must show it).

Start: `git log --oneline -8` + `git rev-parse HEAD` in `/Users/mikeolab/spaceworker`.
Baseline: TASK_187 = `c96c272` (A notify) · `874162f` (B money) · `515c92e` (C UI) ·
`af54d26` (S5 docs) on top of `62ffb3e` (TASK_185).

## 1. Config & alerting (S1 — the original root cause was CONFIG)
- On the box (read-only): `grep -E '^ADMIN_EMAIL=' /opt/spaceworker/.env` must be
  `ADMIN_EMAIL=myrate619@gmail.com`; if a deploy ever dropped it, admin alerts silently
  fall back to `EMAIL_FROM` — that was the entire S1 bug.
- psql (read-only; camelCase columns MUST be quoted, pipe SQL over stdin — nested-quote
  ssh one-liners WILL mangle): recent `admin_pending_payment` rows must show
  `recipient=myrate619@gmail.com, outcome=sent` (NOT `spaceworker@instaweb.top`).
  Owner eyeball of a real alert email = final evidence.

## 2. Support notifications (S2) + invoice composer (S3/S4)
- Static: `notifyAdminTicketCreated` in `app/api/support/tickets/route.ts`;
  `notifyUserTicketReply` in `app/api/admin/support/tickets/[id]/messages/route.ts`
  (fires ONLY when `invoiceId` is absent — invoice-attached replies double-email by
  design); `notifyAdminPendingPayment` ≥3 call sites across billing submit+topup.
- Schema: `PremiumInvoice.days Int?`, `SupportMessage.invoiceId`, `Payment.invoiceId`;
  migration `20261119000000_task187_invoice_days_thread_ref` (+ `LOCK.md`) applied
  (`_prisma_migrations` newest) and §6b drift = `-- This is an empty migration.`
- UI: shipped client chunk contains `Send invoice`, `Duration (days`, `blank = default`.
  NO term/duration string on ANY user surface (invoice email, support card, widget);
  billing page's "activated for 30 days." fallback predates 187 (wallet-spend path).
- Suites: `test:invoice` ≥34, `test:support` ≥57 (run support ×3 — flake = investigate).
  If you do a live e2e, follow the harness rules in §5 below.

## 3. Regressions + deploy-state
- `npx tsc --noEmit` → 0; ESLint touched files → 0 NEW.
- Suites: `test:xdevice` 38 · `test:wallet` 63 · `test:module-gate` 13 ·
  `test:devices` 6 · `test:wrapper-cookie` 6 · `test:invoice` · `test:support`.
  (`test:maintenance-cache` was listed by the ORIGINAL prompt but does NOT exist in
  package.json — prompt drift, do not fail on it.)
- Prior tasks intact: TASK_184 locks (anon 401 → free session **403
  `extractor_required`**), TASK_185 ("activity unknown" never renders), TASK_186
  (payment-notify on submit+topup), TASK_183 ($500 wrapper refs + Wrapper chunks),
  joker page root-only on `spaceworker.instaweb.top`.
- Deploy-state: fresh `BUILD_ID`, service `active`, `spaceworker.top` 200,
  repo↔box md5 parity on touched files, secrets scan over new commits = 0 hits.

## 4. Live-harness rules (learned the hard way — 2026-10-09)
- tsx runs as CJS: **IIFE, never top-level await**; needs
  `npx tsx --require ./scripts/stub-server-only.cjs --env-file=.env` from `/opt/spaceworker`.
- Cleanup order: `PaymentVerificationAttempt` → `Payment` → `PremiumInvoice` →
  messages → ticket → user (FK RESTRICT will abort you otherwise).
- **NEVER delete NotificationLog rows by `userId`**: `recordNotificationLog` resolves
  `userId` by recipient lookup, so owner-inbox rows share the owner's user id — that is
  exactly how the implementer's "kept" audit rows vanished. Delete only rows whose
  `recipient` is your throwaway address; re-assert owner rows AFTER cleanup.
- Poll (~12s) for email rows — notify is fire-and-forget. Delete the harness from BOTH
  ends after the run.

## 5. HANDOFF + REPORT
- Append evidence to `TASK_187_STEPS.md`; keep `SENIOR_HANDOFF.md` §6 current;
  REWRITE this prompt again for the next rolling run; commit with explicit messages; push.
- Report: PASS/FAIL table over §1–§3, regression output, deploy evidence (BUILD_ID,
  NotificationLog row ids, chunk greps), and an OPENLY UNVERIFIED list.
