#!/usr/bin/env bash
set -u
F=/Users/mikeolab/spaceworker/TASK_207_STEPS.md
cat >> "$F" <<'EOF'

## S3 DEPLOY — DONE & VERIFIED (2026-10-15). BOTH SIDES LIVE.

### Deploy results (executed in the locked order)
1. **Vantra first** (scripts/t207-vantra-deploy.sh, recreated hardened — the
   old deploy-vantra-relay.sh was swept in the task-205 script cleanup):
   BUILD_ID `qUqm61vfFmitFjiOPWw9Q` → **`JiHmYVEgGEJyrBLNEe7-2`**, service
   active, :3300 = 200, `.next.bak-t207` cleaned on success, build log at
   /tmp/vantra-build-t207.log on box. Box route scope refs = 11.
2. **SpaceWorker second** (hardened deploy-vps.sh, list =
   components/device-console.tsx + lib/device-tools.ts + tests×2;
   **device-onboarding.ts excluded per preflight decision 3**):
   BUILD_ID `frIasgkyQ7uJdtkZSDPQ5` → **`LV5YN3X3CbJDMU8NfNn25`**, service
   active, :3500 = 200, public spaceworker.top = 200, maintenance OFF (never
   stuck — TSTP traps held).

### Post-deploy verification (all from box + live API)
- Box greps: device-console `useIsMobileViewport` = 2, `noopener,noreferrer` = 1;
  device-tools `scope=device` = 3. ✓
- device-onboarding exclusion PROVEN: box md5 `8c87ca31befb41ad6b4ff93fb057e440`
  == local `git show agent/task-206-quarantine-rework:` md5 EXACT (the
  `ae123b47…` cited in the preflight block was a git BLOB hash, not md5 —
  same file, different hash function; corrected here). origin/main md5 differs
  (`bb8750cc…` = the old 20-min version, NOT on box). 206's 10-min machine intact.
- **Live customer curl (login → mesh-urls):** 200, `ok:true`. urls keys =
  hostname/control/terminal/file/status/client/site and **NO `login`/`meshLogin`
  keys** = the new SHARE-token mint ran (share tokens are node-bound at
  creation by MeshCentral), not the old group user-login mint.
- `scoped` flag not echoed to browser BY DESIGN: vantra returns it top-level
  (route L58 scoped:true / L69 scoped:false on loud-fallback); spaceworker
  fetchMeshUrls destructures and consumes it (backstop L182) without re-echoing.
- Failure markers absent: vantra `scoped console mint FAILED` = 0 hits /
  spaceworker `scoped:false` backstop = 0 hits in the last 10 min of journals.
- Token decode attempt: control token is not a dot-JWT (UnicodeDecodeError on
  middle segment) — shape evidence (above) used instead; share tokens cannot
  open other nodes by construction.

### Learnings (this deploy)
1. **Never `rm` the log AFTER `exec > >(tee …)`** — the rm unlinked the path;
   all script output went to an orphaned inode and was unreadable. (Deploy
   actions unaffected; verified everything via box state instead.) Rule: rm
   BEFORE opening the tee, or use `>` fresh-truncate with tee -a removed.
2. `sleep N; poll` wrapper commands exit 1 via shell-integration heuristics even
   when fine — always follow with direct file reads / box state as ground truth.

### TASK_207 STATUS NOW
- Vantra V1 committed `0f31097` + DEPLOYED. SpaceWorker S1+S2 committed
  `57be273` + DEPLOYED. S3 complete. **Only S4 open: owner live phone test**
  (user opens console on mobile → confirm new-tab launcher, no other-user
  nodes anywhere in the UI, token scoped per-device).
- QUEUE: cyberlab deploy for the other agent's work when the owner hands me
  the handoff (deploy from /Users/mikeolab/sw-lab per the established procedure).
EOF
wc -l < "$F"
echo APPENDED_S3
