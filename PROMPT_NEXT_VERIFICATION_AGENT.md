# PROMPT — NEXT VERIFICATION AGENT (TASK_169 short links + TASK_170 mobile)

You verify + deploy the feature agent's work, then queue the next task.
Start: `main` @ `90e4d30` (TASK_168 A+B live, deploy run 37427332704 green).
TASK_133 file is the owner's — never touch it. Never `git stash`; baselines
via throwaway worktree. Never edit `.env`; never build on the VPS. Pushing ≠
deploying. Wallet W5 is next AFTER these two — queue it, don't verify it.

## 1. VERIFY (expect two commits: TASK_169, then TASK_170)

Re-run every gate yourself: `npx tsc --noEmit` · wallet · top-up · support ·
hosting (334) · NEW tests named in the report · ESLint on touched files with
worktree baseline (prove 0 new) · `CI=true npm run build`.
Confirm TASK_169: auto tokens short (length/charset as reported); create
retry loop bounded and token collisions never 409 (only user slugs do);
`resolveLink` (`lib/hosting/links.ts`) still serves slug-first and OLD
24-char tokens resolve; worker map carries short keys; hero URL shown only
when `deployStatus === "live"`; `/r/<key>` fallback always valid.
Confirm TASK_170: at 390px width the remote tab shows the same
Connect → iframe flow as desktop (`components/device-console.tsx`), no
overlay covers the mesh iframe on load or tab switch, iframe fits the
viewport without sideways scroll, desktop rendering unchanged.
`git log origin/main..main --stat` lists ONLY the two commits; `git status`
shows no strays.

## 2. DEPLOY (push only if green; deploy = gh workflow + VPS proof)

If anything red: stop, report, do NOT push. If green: `git push origin
main`, `gh workflow run deploy.yml --ref main`, wait for build+deploy
success on that SHA (a green run with SKIPPED deploy ≠ deployed). Then VPS:
BUILD_ID mtime inside the run window; service restart after; migration
rows present (if any — TASK_169 should need none); unauth probes
401/403-shaped. Post-deploy oneshot failures right after a restart are the
known transient (trap 15) — re-check after the next tick before calling it
red.

## 3. LIVE PROOF for the two tasks

TASK_169: create a link on prod, show the new short URL (length + host),
follow it and show the 302 to the target; show an old 24-char `/r/` URL
still resolving. Raw output only, before + after.
TASK_170: load a device console remote tab in a mobile-width viewport, show
the Connect control and (after connect) the mesh iframe visible with no
covering modal; show the desktop view unchanged. Simulations labelled
SIMULATION, never "verified live".

## 4. WRITE THE NEXT PROMPTS + HANDOFF, commit, report

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for Wallet W5 spend path (handoff §7
row 2b — confirm scope with the owner's order before assigning). Rewrite
THIS file for that task (fresh §1 gates for its scope). Update
SENIOR_HANDOFF.md: §6 state, §7 queue, §9 log entry, §12 evidence. Commit
the three docs explicitly (`git add` paths, `-F` file, `git log -1` to
confirm), push. Report: gate table, deploy run id + SHA, VPS evidence, next
task queued, unverified list.
