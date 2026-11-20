# TASK_CYBERLAB_EGRESS_DEPLOY — STEPS (before/after record)

Deploy owner = me (spaceworker VPS deploy flow). Source = `/Users/mikeolab/sw-lab` local-only
branch `main` (NOT pushed). Runbook = `sw-lab/HANDOFF_CYBERLAB_EGRESS_DEPLOY.md`.

## BEFORE record (2026-10-15, verified by SSH + local git)

**Ground truth**
- sw-lab: branch `main`, HEAD `c22b8b3` (docs on top of runtime HEAD `2497294`),
  ahead of origin/main, tree clean, nothing pushed.
- Box (`root@164.68.105.96:/opt/spaceworker`): BUILD_ID `7hzgmeVMp_wXtOe47TcBr` (clone resync).
- Box schema HAS (must survive): task-205 `desktopTitle` L1604 / `desktopBody` L1605 /
  `mobileTarget` L1612 · `movedAt` ×3 (task-206) · `sourceDeviceId` ×11 (C2b) · root orphan
  schema.prisma GONE.
- Box schema LACKS: all 4 egress columns. sw-lab schema = origin/main + cyberlab only
  (NO task-205 columns) → DO NOT rsync their schema.prisma.

**Schema diff box↔sw-lab (37 lines, exactly 2 hunks):**
1. sw-lab-only @ AdminSetting: comments + 4 egress columns → PORT to box schema (merged upload).
2. box-only @ LinkRedirect: task-205 columns → KEEP.

**Deploy plan (decisions locked)**
- File list = handoff §3 runtime files only (~17), EXCLUDE `prisma/schema.prisma` + 3 test files.
- No `engine/` dir exists; lib/lab imports NO clone/hosting modules (grep-verified).
- DB: handoff §2 audited SQL verbatim via psql (additive, IF NOT EXISTS);
  `cyberlabLiveEgressEnabled @default(true)` backfills singleton → live egress ON.
- Shared files (package.json / globals.css / admin-panel.tsx / lib/entitlements.ts):
  box-hash-classify vs origin/main — ship sw-lab's version only where box == origin/main
  (no box-only hunks to lose).
- Deploy via hardened `scripts/deploy-vps.sh`, `LOCAL_ROOT=/Users/mikeolab/sw-lab`,
  launched from a script file (no inline compound commands).
- Post-verify: handoff §5 + task-205 intactness (LinkRedirect cols still in box schema,
  hosting API 200) + BUILD_ID new + maintenance OFF.
- Then deploy task-208 separately from spaceworker `agent/task-208-neko-mobile`
  (lib/touch-controls.ts + browser-session-panel.tsx), verify, record.

**Status:** BEFORE recorded. Implementation pending.
