### PROMPT E — WALLET W2 (+ the deploy of `5462981` it is blocked behind)

Copy this to the next wallet engineer.

```
You are the engineer for SpaceWorker Task 158 Wallet W2. Mike owns the product; you own the
correctness of the code.

REPO: /Users/mikeolab/spaceworker  (branch: main)

BEFORE ANY CODE — read these, in this order:
  cat SENIOR_HANDOFF.md          (single source of truth; §0 and §10 are binding on you)
  cat HOW_WE_MOVE_FAST.md       (deploy + verification playbook; skim the incident narratives)
  cat PLAN_TASK_158_WALLET_BALANCE.md
  cat TASK_161_DASHBOARD_OS.md  (why W2 is blocking a UI phase)

STEP 0 — DEPLOY THE ALREADY-COMMITTED WORK. This is not optional and not your code.
  Commit 5462981 (wallet W1 + the Task 160 Zones probe) is committed locally but NOT pushed,
  NOT deployed, and its migration is NOT applied in production. Do exactly:
    git --no-pager log --oneline -3
    git fetch origin && git status --short   # confirm clean + no divergence
  Then re-run the FULL gate yourself, from scratch:
    npx tsc --noEmit
    npm run test:hosting     # expect 334/334
    npm run test:support     # expect 30/30
    npm run test:wallet      # expect 29/29
    npx eslint <each file you touched>
    CI=true npm run build
    scripts/replay-wallet-migration.sh
  Then dry-run migration 20261110000000_task158_wallet against a production schema CLONE and
  assert its CHECK constraints BEHAVIORALLY (try to violate each one, confirm it is rejected) —
  a migration that applies cleanly but does not enforce is worse than no migration.
  Only then: push main, dispatch deploy.yml, MONITOR THE RUN TO COMPLETION.
  Then live-verify: new BUILD_ID; the wallet migration ledger row; the new columns/table/
  constraints; active services; wallet/support routes; the deployed zone-probe strings.
  Record the deploy ID and live results in the task docs. If anything fails, STOP and report —
  do not proceed to Step 1 on top of an unverified deploy.

STEP 1 — W2 SCOPE (this is your actual task):
  GET /api/wallet  — authenticated, returns the current user's wallet view.
  Requirements:
    - Session from the session on the REQUEST only. Never from a body or query param.
    - Return lib/wallet.ts getWallet(): balanceCents, spendableCents, postpaidLimitCents,
      prepaidOnly. Integer cents end to end; formatCents only for display.
    - Rate-limit it, as the other authenticated read routes in this repo do.
    - No new table, no migration.
  Plus the minimum read-only UI to prove it end to end: a balance display on /dashboard/billing.
  Keep it small — W3 (admin grant) and W5 (spend) are separate tasks and must stay separate.

NON-NEGOTIABLES (from PLAN_TASK_158 §8 and handoff §5):
  - lib/wallet.ts stays price-agnostic and is the ONLY writer of User.balanceCents.
  - The ledger is append-only: no update/delete on WalletLedgerEntry, ever.
  - Guard, don't check-then-act: every mutation is a conditional updateMany whose count === 0
    is the failure signal.
  - Debit+entitlement and credit+payment-status each commit in ONE transaction or not at all.
  - No float money. Integer cents.
  - Never log or return a Cloudflare token; never accept a secret via argv.

VERIFY BEFORE YOU CLAIM DONE — the evidence standard is handoff §8:
  Add cases to tests/wallet.test.ts. Re-run tsc, all three suites, ESLint, CI=true npm run build.
  Then deploy, then curl the live route and show real output. "It works locally" is not evidence.
  If NO CI workflow runs these tests (it does not — handoff §5 trap 2), YOUR run is the only one.

THEN: update PLAN_TASK_158_WALLET_BALANCE.md (W2 done, deploy ID, live results),
TASK_160_CAPABILITY_TOKEN_ERROR_COLUMNS.md (deployed + live-verified), and SENIOR_HANDOFF.md
§6/§7/§12 per §10. Commit, push, AND deploy — three separate steps. Code-complete + doc-stale
== a broken handoff.

REPORT BACK: the commit SHA, the deploy run ID, the live BUILD_ID, the migration ledger row,
the curl output, and anything surprising you found.
```
