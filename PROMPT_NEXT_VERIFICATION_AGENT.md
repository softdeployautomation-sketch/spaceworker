# PROMPT — NEXT VERIFICATION AGENT (TASK_175 desktop-only gate; P0 VERIFIED LIVE 2026-10-06)

P0 silent-install fix is VERIFIED LIVE (see §1). You verify the TASK_175
desktop-only link-gate build, then queue the grant fix.

Start: spaceworker main at 498d2e7 (TASK_172 verify docs commit).
The P0 fix is NOT a spaceworker commit: it is live on the VPS
generator and ALREADY VERIFIED (md5 match, service active,
ENDS_SILENT:true probe — see §7 row 0 + §12 log). Do NOT re-verify P0
beyond a quick md5 + is-active sanity check. TASK_133 is the owner's
— never touch it. Never git stash; baselines via throwaway worktree.
Never edit .env; never build on the VPS.

## 1. ALREADY VERIFIED — P0 silent fix (do not redo; sanity-check only)

md5 `00ef606a22342c9fba6405d8471d603c` live; service active; probe
`ENDS_SILENT:true`; `routes.ts:668/775/812` embedding; gates recorded in
§7 row 0 + §12 log (support 49/50 pre-existing flake documented there).
Sanity check = `md5sum` + `systemctl is-active` only. GUI-silence stays
SIMULATION until the owner confirms on hardware.

## 2. VERIFY (expect: desktopOnly flag + resolver interstitial + mint UI)

Re-run every gate yourself: npx tsc --noEmit, vantra-link-installer,
wallet, top-up, support, hosting, idlechip suites, ESLint on touched
files with worktree baseline (prove 0 new), CI=true npm run build,
prisma validate (expect NO new migration — flag any as unexpected).

Confirm TASK_175: mint a desktopOnly link through the public flow and
show with curl — mobile UA gets the white-modal HTML (no redirect),
desktop UA gets today's 302 byte-identical, `?desktop=1` 302s even on
mobile UA; flag-off links 302 for both UAs; expired/revoked still 410.
Confirm W5 still live (POST /api/wallet/spend shapes). git log
origin/main..main lists ONLY the build commit; no strays.

## 3. DEPLOY (push only if green; deploy = gh workflow + VPS proof)

If anything red: stop, report, do NOT push. If green: git push origin
main, gh workflow run deploy.yml --ref main, wait for build+deploy
success on that SHA (a green run with SKIPPED deploy is not deployed).
Then VPS: BUILD_ID mtime inside the run window; service restart after;
unauth probes 401/403-shaped. Post-deploy oneshot failures right after
a restart are the known transient (trap 15) — re-check after the next
tick before calling it red.

## 4. WRITE THE NEXT PROMPTS + HANDOFF, commit, report

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for the GRANT FIX (row 0c, SMALL,
root-caused in §7: nullable-admin — `adminId: null` for the
shared-passcode admin in `app/api/admin/wallet/grant/route.ts` +
try/catch → JSON 500 + "grant with null adminId succeeds" test; no
migration; verify on prod with a real grant).
Rewrite THIS file for that task (fresh section 1 gates for its scope).
Update SENIOR_HANDOFF.md: section 6 state, section 7 queue, section 9
log entry, section 12 evidence. NOTE nested folder 0b + W6 AFTER the
grant fix per owner order. Commit the three docs explicitly
(git add paths, -F file, git log -1 to confirm), push. Report: gate
table, live curl proof, next task queued, unverified list.
