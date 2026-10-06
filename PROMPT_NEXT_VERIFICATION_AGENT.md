# PROMPT — NEXT VERIFICATION AGENT (WALLET W5 spend on premium)

You verify Wallet W5 (spend funded balance on premium terms), then queue W6.
Start: main at feature-agent's W5 commit (POST /api/wallet/spend +
Activate-with-balance UI), pushed by them. TASK_171 zip-link history
(307d152) is live. TASK_133 file is the owner's — never touch it. Never
git stash; baselines via throwaway worktree. Never edit .env; never build
on the VPS. Pushing is not deploying. W6 (EXE-from-wallet) is next — queue
it, do not build it.

## 1. VERIFY (expect one commit: Wallet W5 spend path)

Re-run every gate yourself: npx tsc --noEmit, hosting, wallet, top-up,
support, idlechip, NEW tests named in the report, ESLint on touched files
with worktree baseline (prove 0 new), CI=true npm run build,
prisma validate (expect NO new migration — W1 already shipped the ledger;
if one exists, timestamp must be strictly greater than
20261114000000_task171_install_link_history and additive-only).

Confirm W5 on /dashboard/billing + POST /api/wallet/spend: body product
web_subscription ONLY (EXE products rejected — W6 not started); session
user id only (no userId param, no body id); price from the SAME source as
the crypto checkout (no second constant); ONE transaction for debit +
premium term grant (30 days via PREMIUM_DAYS_PER_CHARGE, tier to 5);
insufficient = 402 insufficient_funds with nothing moved; already-active =
409 already_active with nothing moved (extend-vs-refuse documented);
concurrent full-balance double-spend = exactly one success via CAS
(wallet_contended 409 for the loser); ledger row kind debit_purchase,
append-only (no update/delete on WalletLedgerEntry); lib/wallet.ts still
the ONLY balance writer (no prisma.user.update of balanceCents elsewhere);
integer cents end to end; Activate-with-balance UI refreshes the balance.
git log origin/main..main --stat lists ONLY the W5 commit; git status
shows no strays.

## 2. DEPLOY (push only if green; deploy = gh workflow + VPS proof)

If anything red: stop, report, do NOT push. If green: git push origin
main, gh workflow run deploy.yml --ref main, wait for build+deploy
success on that SHA (a green run with SKIPPED deploy is not deployed).
Then VPS: BUILD_ID mtime inside the run window; service restart after;
migration rows present (W5 should need none — flag any migration as
unexpected); unauth probes 401/403-shaped (GET /api/wallet = 401,
POST /api/wallet/spend = 401). Post-deploy oneshot failures right after a
restart are the known transient (trap 15) — re-check after the next tick
before calling it red.

## 3. LIVE PROOF for W5

Fund a test wallet on prod (grant or top-up + approve), spend on premium
via POST /api/wallet/spend, and show: balance down by exactly the price,
premiumExpiresAt extended by 30 days (tier 5), ledger debit_purchase row
present; second spend while active = 409 with nothing moved; insufficient
spend = 402 with nothing moved. Raw output only. Simulations labelled
SIMULATION, never verified live.

## 4. WRITE THE NEXT PROMPTS + HANDOFF, commit, report

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for Wallet W6 EXE-from-wallet
(handoff section 7 row W6 — confirm scope with the owner's order before
assigning). Rewrite THIS file for that task (fresh section 1 gates for its
scope). Update SENIOR_HANDOFF.md: section 6 state, section 7 queue,
section 9 log entry, section 12 evidence. Commit the three docs explicitly
(git add paths, -F file, git log -1 to confirm), push. Report: gate table,
deploy run id + SHA, VPS evidence, next task queued, unverified list.
