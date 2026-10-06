# PROMPT — NEXT VERIFICATION AGENT (P0 silent-install fix)

You verify the P0 silent-install fix, then queue the nested-folder task.

Start: spaceworker main at b3e2540 (W5 spend path, pushed; deploy run
37470986552 success — confirm live as part of this run). The feature agent's
fix is NOT a spaceworker commit: it is a one-line edit on the VPS generator
(/opt/vantra-installer/generator/src/install-command.ts + service restart).
Your spaceworker-side job is gates + live proof + doc queue. TASK_133 file is
the owner's — never touch it. Never git stash; baselines via throwaway
worktree. Never edit .env; never build on the VPS.

## 1. VERIFY (expect: live generator carries --silent; spaceworker docs commit)

Re-run every gate yourself: npx tsc --noEmit, hosting, wallet, top-up,
support, idlechip suites, ESLint on touched files with worktree baseline
(prove 0 new), CI=true npm run build, prisma validate (expect NO new
migration — this fix touches no schema; flag any migration as unexpected).

Confirm the fix on the VPS (ssh key ~/.ssh/tacticalrmm_vps):
grep -n silent /opt/vantra-installer/generator/src/install-command.ts shows
the `--silent` argv line inside buildEnrollmentCommand (not comments only);
systemctl is-active vantra-msi-generator = active; journalctl clean start.
Mint a test zip through the Spaceworker public flow and show the embedded
enrollment command ends in --silent. GUI-silence needs a Windows VM — accept
the agent's SIMULATION label unless the owner confirms on hardware; never
claim live GUI-silence without it.

Confirm W5 still live on /dashboard/billing + POST /api/wallet/spend (body
product web_subscription ONLY; session user id only; price from the checkout
source; 402/409 shapes). git log origin/main..main lists ONLY the docs
commit; git status shows no strays.

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

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for the nested launcher folder
(TASK_173 candidate — owner wants launcher in a second folder nested inside
the first, .lnk targeting the right path; scope launcher.c, lnk target,
generator innerFolder contract, Vantra parity — do NOT build it here).
Rewrite THIS file for that task (fresh section 1 gates for its scope).
Update SENIOR_HANDOFF.md: section 6 state, section 7 queue, section 9 log
entry, section 12 evidence. NOTE the grant bug as queued triage (admin
Give-a-customer-funds 50 USD founders-funding returned Grant failed; route
+ service exist, root cause open) and W6 EXE-from-wallet AFTER the
nested-folder + grant bug per owner order. Commit the three docs explicitly
(git add paths, -F file, git log -1 to confirm), push. Report: gate table,
generator live evidence, next task queued, unverified list.
