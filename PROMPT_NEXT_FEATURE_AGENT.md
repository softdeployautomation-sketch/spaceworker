# PROMPT — NEXT FEATURE AGENT (queue: WALLET W5 — spend on premium, premium-only)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md section 1 — binding.
- Rules: git add explicit paths only (TASK_133 file is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never build on the VPS; never git stash; use CI=true npm run build.
- State: main at 307d152 (TASK_171 zip-link history: VantraInstallLink
  per-mint history + download counts + live countdowns in the Add-a-device
  panel), pushed AND deployed (run 37451784379, build+deploy success,
  migration 20261114000000_task171_install_link_history applied live,
  VantraInstallLink count 0 = no mints since deploy). TASK_169/170 live —
  do not touch them.
- Short links are SETTLED (premium serves only from the short swdocs host).
  Zip-link history is SETTLED (TASK_171). Do not re-litigate either.

## 1. WALLET W5 — POST /api/wallet/spend for web_subscription (premium-only)

Owner scope decision (2026-10-06): W5 premium-only. W6 (EXE-from-wallet,
dual-provenance issueExeLicense refactor) is a separate later task — do not
start it, do not widen this task to EXE products.

Owner ask (PLAN_TASK_158_WALLET_BALANCE.md 7.1): users fund the wallet first
(W3 grant + W4 top-up to admin credit — both LIVE), then spend that balance
on subscription. The wallet today can be FILLED but not SPENT. This task
closes that loop for the web subscription only.

### Verified facts (reproduce, do not assume)

- lib/wallet.ts is the ONLY money writer: creditWallet, debitWallet (kind
  debit_purchase, allowNegative postpaid headroom), grantBalance
  (admin_grant / admin_adjust sign-routing), setPostpaidLimit.
  Compare-and-swap on the balance value itself, up to 5 retries, then 409
  wallet_contended. Idempotency via idempotencyKey unique. Ledger
  WalletLedgerEntry is append-only. Tests: tests/wallet.test.ts 39/39.
- GET /api/wallet reads the caller's own wallet from the session — no
  userId param, no body, integer cents end to end.
- No spend route exists: no app/api/wallet/spend directory, no spend string
  in app/lib/components/tests for the wallet path.
- Premium model (lib/premium.ts): PREMIUM_TIER = 5,
  PREMIUM_DAYS_PER_CHARGE = 30; grandfathered tier-5 NULL-expiry never
  expires; lazy applyPremiumReversion downgrades expired terms to tier 1.
- Premium price today lives in the crypto checkout path
  (app/api/billing/checkout, lib/products.ts); the spend route must price
  from the SAME source, never a second constant.

### W5 fix contract

1. New authenticated route POST /api/wallet/spend, body
   product web_subscription (reject anything else — EXE is W6). Session user
   id ONLY (same rule as GET /api/wallet). Integer cents end to end.
2. Atomic in ONE transaction: debitWallet (CAS + idempotency) + premium term
   grant (extend premiumExpiresAt by 30 days, or start a new term from now;
   tier to 5). A crash can never take money without granting premium, or
   grant it for free. Ledger row kind debit_purchase with a note naming the
   product + term.
3. Failure shapes: insufficient balance = 402 insufficient_funds;
   already-premium-with-live-term = 409 already_active (document extend vs
   refuse; default refuse); concurrent spend = 409 wallet_contended via CAS;
   unknown product = 400/422.
4. Invariants kept: lib/wallet.ts stays the only balance writer; ledger
   stays append-only; admin session checks unchanged; rate-limit the route
   like the other wallet/billing routes.
5. UI: Activate with balance on /dashboard/billing (plan section 7 W5 gate)
   + balance refresh after spend. Reuse components/wallet-balance.tsx
   formatting (cents to display in the browser only).
6. Tests: spend debits once + grants term atomically; double-spend of the
   full balance = exactly one success; insufficient = 402 and nothing moves;
   already-active = 409 and nothing moves; concurrent spends = one wins via
   CAS; EXE product = rejected (W6 not started). Existing suites green.
7. Gates before commit: tsc + wallet + topup + support + hosting + idlechip
   suites + ESLint touched-only (worktree baseline, 0 new) + CI=true build
   + prisma validate (expect NO migration — W1 already shipped the ledger;
   if one is truly needed, timestamp strictly greater than
   20261114000000_task171_install_link_history). One commit, explicit
   git add, -F file, push (push is not deploy, leave deploy to verifier).

## 2. What is NOT this task

- W6 (EXE-from-wallet, ExeLicense.paymentId nullable + walletEntryId +
  CHECK constraint, issueExeLicense dual provenance, replace/re-issue
  surface in /dashboard/licenses). Queued after W5, not now.
- Postpaid changes (D10 postpaidLimitCents ceiling already exists — spend
  via allowNegative headroom only, no new limit surface).
- New top-up methods, new currencies, refunds UI, store multiselect.

## 3. Report back

1. W5: route + UI paths (file:line); atomic debit+grant shape; price source;
   already-active decision; gate table, real output.
2. Honest unverified list (anything not run live).
