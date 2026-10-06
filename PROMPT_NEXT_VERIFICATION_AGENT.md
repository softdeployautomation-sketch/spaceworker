# PROMPT — NEXT VERIFICATION AGENT (TASK_168: queue P0 + summary dial)

You verify + deploy the TASK_168 agent's work, then queue the next task.
Start: `main` @ `08cd67c` (TASK_167 W3+W4 live). TASK_133 file is the
owner's — never touch it. Never `git stash`; baselines via throwaway
worktree. Never edit `.env`; never build on the VPS. Pushing ≠ deploying.

## 1. VERIFY (expect two commits: Bug A, then Bug B)

Re-run every gate yourself: `npx tsc --noEmit` · wallet 39 · topup 22 ·
support 50 · hosting 334 · NEW tests named in the report · ESLint on
touched files with worktree baseline (prove 0 new) · `CI=true npm run build`.
Confirm: worker lane semaphores read the admin dial (no hardcoded 1);
Phase A fairness (full lane X + healthy lane Y → Y dispatches, test);
requeue rows clean; stuck-`running` releases its slot; 404 → failed kept.
Confirm: migration adds the two `screenshotSummary*` columns (defaults
24/8, applied additive); copy interpolates the dial; admin UI shows both;
scratch replay done. `git log origin/main..main --stat` lists ONLY the two
commits; `git status` shows no strays.

## 2. DEPLOY (push only if green; deploy = gh workflow + VPS proof)

If anything red: stop, report, do NOT push. If green: `git push origin
main`, `gh workflow run deploy.yml --ref main`, wait for build+deploy
success on that SHA (a green run with SKIPPED deploy ≠ deployed). Then VPS:
BUILD_ID mtime inside the run window; service restart after; migration
rows present; live dials readable; unauth probes 401/403-shaped. Post-deploy
oneshot failures right after a restart are the known transient (trap 15) —
re-check after the next tick before calling it red.

## 3. LIVE PROOF for the two bugs

Bug A: set the lane dial to 3 on prod (or confirm the owner's 3), run 3
users' extractions concurrently, show all 3 progressing/receiving (Phase B
`liveUpdated`, worker JOBS, DB leads) — not one. Restore the dial after.
Bug B: set summary frames dial ≠ 24, show timeline copy carrying the new
number; set back afterwards. Raw output only, before + after. Simulations
labelled SIMULATION, never "verified live".

## 4. WRITE THE NEXT PROMPTS + HANDOFF, commit, report

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for the next queue item (Wallet W5
spend path sits in handoff §7 row 2b — confirm it is still next with the
owner's order before assigning). Rewrite THIS file for that task (fresh
§1 gates for its scope). Update SENIOR_HANDOFF.md: §6 state, §7 queue,
§9 log entry, §12 evidence. Commit the three docs explicitly
(`git add` paths, `-F` file, `git log -1` to confirm), push. Report: gate
table, deploy run id + SHA, VPS evidence, next task queued, unverified list.
