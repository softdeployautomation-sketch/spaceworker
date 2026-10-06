# PROMPT — NEXT VERIFICATION AGENT (TASK_175 DEPLOYED 2026-10-06 + TASK_176 QUEUED)

P0 silent-install fix is VERIFIED LIVE (md5 `00ef606a22342c9fba6405d8471d603c`,
service active — see SENIOR_HANDOFF §7 row 0). TASK_175 desktop-only gate
is BUILT + PUSHED (`f27fa8b`) and DEPLOYED via run `37502808339` — you
confirm it LIVE, then queue TASK_176.

Start: spaceworker main at `f27fa8b` (TASK_175 build commit).
Scope docs: `TASK_175_DESKTOP_ONLY_LINK_GATE.md` §3 (premium gating) +
`TASK_176_NESTED_LAUNCHER_SINGLE_RENAME.md` (next task). TASK_133 is the
owner's — never touch it. Never git stash; baselines via throwaway
worktree. Never edit .env; never build on the VPS.

## 1. ALREADY VERIFIED — TASK_175 gates (do not redo; live-confirm only)

Local gates green this session: tsc clean, hosting 338/338, gate 12/12,
vantra 68/68, wallet 47/47, topup 22/22, support 50/50, idlechip 15/15,
prisma validate ok, CI build ok. One ESLint error in hosting-panel is
PRE-EXISTING on HEAD (untouched effect line — proven via `git show`).

## 2. CONFIRM LIVE (the deploy evidence)

1. Deploy run `37502808339` (manual dispatch): build+deploy both
   success on SHA `f27fa8b` (a green run with SKIPPED deploy is not
   deployed). VPS: BUILD_ID mtime inside the run window; service
   restart after; unauth probes 401/403-shaped.
2. Re-run the curl proof AGAINST PROD (premium mobile HTML + desktop
   302 + free-mint drop) and report raw output.
3. Migration `20261115000000_task175_desktop_only_link_gate` applied
   (ledger +1, `desktopOnly` column present, pre-flag rows NULL).

If anything red: stop, report, do NOT re-push. Post-deploy oneshot
failures right after a restart are the known transient (trap 15) —
re-check after the next tick before calling it red.

## 3. QUEUE NEXT (already scoped — do NOT rebuild the scope)

TASK_176 nested launcher (`TASK_176_NESTED_LAUNCHER_SINGLE_RENAME.md`,
SMALL): generator doubles the ONE folder name (`acme` →
`acme/acme/Launcher.exe`), bridge `-LauncherSubFolder` takes the joined
path, NO Vantra change, NO SpaceWorker UI change. The next feature
agent builds it per `PROMPT_NEXT_FEATURE_AGENT.md`.

## 4. WRITE THE HANDOFF, commit, report

Update SENIOR_HANDOFF.md: section 6 state (TASK_175 live), section 7
queue (strike 0e, TASK_176 next), section 9 log entry, section 12
evidence. Commit the docs explicitly (git add paths, -F file,
git log -1 to confirm), push. Report: gate table, live curl proof,
next task queued, unverified list.
