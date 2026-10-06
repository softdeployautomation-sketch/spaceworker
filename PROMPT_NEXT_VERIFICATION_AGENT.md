# PROMPT — NEXT VERIFICATION AGENT (TASK_173 nested folder; P0 VERIFIED LIVE 2026-10-06)

P0 silent-install fix is VERIFIED LIVE (see §1). You verify the TASK_173
nested-folder build, then queue the grant fix.

Start: spaceworker main at ccd8293 (P0 docs commit, pushed; build-only
run 37480260244 success, deploy skipped by design — no Spaceworker code
changed). The P0 fix is NOT a spaceworker commit: it is live on the VPS
generator and ALREADY VERIFIED this session (md5 match, service active,
ENDS_SILENT:true probe, routes.ts:668/775/812 embedding — see §7 row 0 +
§12 log 2026-10-06 VERIFIED). Do NOT re-verify P0 beyond a quick md5 +
is-active sanity check. Your spaceworker-side job is gates + the TASK_173
proof + doc queue. TASK_133 file is
the owner's — never touch it. Never git stash; baselines via throwaway
worktree. Never edit .env; never build on the VPS.

## 1. ALREADY VERIFIED — P0 silent fix (do not redo; sanity-check only)

md5 `00ef606a22342c9fba6405d8471d603c` live; service active; probe
`ENDS_SILENT:true`; `routes.ts:668/775/812` embedding; gates recorded in
§7 row 0 + §12 log (support 49/50 pre-existing flake documented there).
Sanity check = `md5sum` + `systemctl is-active` only. GUI-silence stays
SIMULATION until the owner confirms on hardware.

## 2. VERIFY (expect: live generator carries the nested layout; spaceworker forwarding commit)

Re-run every gate yourself: npx tsc --noEmit, hosting, wallet, top-up,
vantra-link-installer, support, idlechip suites, ESLint on touched files
with worktree baseline (prove 0 new), CI=true npm run build, prisma
validate (expect NO new migration for either task — flag any migration as
unexpected).

Confirm the P0 fix on the VPS (ssh key ~/.ssh/tacticalrmm_vps):
grep -n silent /opt/vantra-installer/generator/src/install-command.ts shows
the `--silent` argv line inside buildEnrollmentCommand (not comments only);
systemctl is-active vantra-msi-generator = active; journalctl clean start.

Confirm TASK_173 nested folder: mint a test zip through the Spaceworker
public flow and show the entry list =
`Update.lnk` at root + `<inner>/<nested>/Launcher.exe` +
`<inner>/<nested>/agent.bin` (+ PDF beside the exe when attached); show the
bridge Update.lnk args contain `.\<inner>\<nested>\Launcher.exe`; confirm
the embedded enroll command STILL ends in `--silent` (nested change must
not regress P0). VM
install is the only end-to-end proof — accept the agent's SIMULATION label
unless the owner confirms on hardware; never claim live install success
without it.

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

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for the GRANT FIX (row 0c, SMALL,
root-caused in §7: nullable-admin — `adminId: null` for the shared-passcode
admin in `app/api/admin/wallet/grant/route.ts` + try/catch → JSON 500 +
"grant with null adminId succeeds" test; no migration; verify on prod with
a real grant showing balance +X and an `admin_grant` ledger row with the
note).
Rewrite THIS file for that task (fresh section 1 gates for its scope).
Update SENIOR_HANDOFF.md: section 6 state, section 7 queue, section 9 log
entry, section 12 evidence. NOTE W6 EXE-from-wallet AFTER the grant fix per
owner order. Commit the three docs explicitly
(git add paths, -F file, git log -1 to confirm), push. Report: gate table,
generator live evidence, next task queued, unverified list.
