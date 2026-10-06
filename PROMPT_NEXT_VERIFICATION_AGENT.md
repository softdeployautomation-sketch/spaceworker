# PROMPT — NEXT VERIFICATION AGENT (TASK_171 zip-link history)

You verify TASK_171 (zip-link history), then queue Wallet W5.
Start: `main` @ feature-agent's TASK_171 commit (history model + panel rows +
download counts), pushed by them. Premium short-link fix `95a6f47` is live.
TASK_133 file is the owner's — never touch it. Never `git stash`; baselines
via throwaway worktree. Never edit `.env`; never build on the VPS. Pushing ≠
deploying. Wallet W5 is next — queue it, don't build it.

## 1. VERIFY (expect one commit: TASK_171 zip-link history)

Re-run every gate yourself: `npx tsc --noEmit` · hosting · wallet ·
top-up · support · idlechip · NEW tests named in the report · ESLint on
touched files with worktree baseline (prove 0 new) · `CI=true npm run build`
· `prisma validate`.
Confirm TASK_171 in the Add-a-device public tab (`components/device-list.tsx`),
NOT the hosting panel: re-mint keeps ALL of the user's links (newest first),
each row shows URL + copy, a live "expires in Xh Ym" / "expired" countdown
from `expiresAt`, and its download count; old rows are copy-only; current
link's Generate/"New link" unchanged. Confirm the model: additive-only
migration (new per-mint table with tokenHash unique + downloadCount default
0 — `VantraLink` still one row per user pointing at current); raw tokens
hash-only in DB, `installerUrl` still server-only (never in view/response/
log/audit); `resolveInstallToken` counts one open = one download,
best-effort (a count write never breaks the 302), expired/unknown count
nothing; revoked users resolve nothing and get no list; public-PS +
private-tier paths untouched. `git log origin/main..main --stat` lists ONLY
the TASK_171 commit; `git status` shows no strays.

## 2. DEPLOY (push only if green; deploy = gh workflow + VPS proof)

If anything red: stop, report, do NOT push. If green: `git push origin
main`, `gh workflow run deploy.yml --ref main`, wait for build+deploy
success on that SHA (a green run with SKIPPED deploy ≠ deployed). Then VPS:
BUILD_ID mtime inside the run window; service restart after; migration
rows present (if any — TASK_169 should need none); unauth probes
401/403-shaped. Post-deploy oneshot failures right after a restart are the
known transient (trap 15) — re-check after the next tick before calling it
red.

## 3. LIVE PROOF for TASK_171

Mint a public ZIP link on prod, re-mint, and show BOTH rows in the panel
with live countdowns and counts (before: 1 link, after: N rows); open one
link and show its count increment by one; show an expired row reading
"expired". Raw output only. Simulations labelled SIMULATION, never
"verified live".

## 4. WRITE THE NEXT PROMPTS + HANDOFF, commit, report

Rewrite PROMPT_NEXT_FEATURE_AGENT.md for Wallet W5 spend path (handoff §7
row 2b — confirm scope with the owner's order before assigning). Rewrite
THIS file for that task (fresh §1 gates for its scope). Update
SENIOR_HANDOFF.md: §6 state, §7 queue, §9 log entry, §12 evidence. Commit
the three docs explicitly (`git add` paths, `-F` file, `git log -1` to
confirm), push. Report: gate table, deploy run id + SHA, VPS evidence, next
task queued, unverified list.
