#!/usr/bin/env bash
set -u
F=/Users/mikeolab/spaceworker/TASK_207_STEPS.md
cat >> "$F" <<'EOF'

## S3 PREFLIGHT (2026-10-15) — EVERY collision trap resolved with evidence; READY TO DEPLOY

### Box state at preflight
- Vantra: active, BUILD_ID `qUqm61vfFmitFjiOPWw9Q` (probe deploy), :3300 = 200
- SpaceWorker: active, BUILD_ID `frIasgkyQ7uJdtkZSDPQ5` (task-208), :3500 = 200
- **Box mint route grep "scope" = 0 → scoped mint NOT deployed.**
  Vantra-first order is MANDATORY: the old route silently IGNORES `?scope=device`
  and returns the broad token without `scoped:false`, which would make the
  spaceworker backstop dead code. (Vantra first is inherently safe: new Vantra +
  old spaceworker = scope param never sent = old behavior.)

### Collision decisions (each proven by hash/diff, scripts t207-preflight.sh +
### t207-vantra-boxonly.sh)
1. `components/device-console.tsx` — box hash `fb69788...` == local commit
   `e1314a8` content EXACT (check E) → box predates only my S2 diff → **DEPLOY SAFE**.
2. `lib/device-tools.ts` — box-only lines are the dead `getAdminSettings` import
   and the OLD pre-S1 fetchMeshUrls shape; 3 hunks only (L7, 165-166→164-180,
   167a182-187) → box stale, not customized → **DEPLOY SAFE**.
3. `lib/device-onboarding.ts` — box hash == **206 branch byte-exact**
   (`ae123b4...`, check G) → **EXCLUDE FROM DEPLOY**: shipping my branch's
   origin/main-based copy would regress the deployed 10-min quarantine state
   machine back to 20-min. The box already has the strictly better version
   (my local copy exists only so local tsc is green).
4. Vantra `lib/meshcentral-api.ts` — 12 box-only lines = the OLD inline
   `createDeviceShareLink` JSON payload (`p: 2` + desktop comment), exactly the
   form my TASK_207 refactor replaced with the parameterized console-variant
   helper (behavior locked by `tests/mesh-share-console.test.ts`, part of the
   60/60 green run) → **DEPLOY SAFE** (replacement, not regression).
5. Vantra mint route — 4 box-only lines = old route form (old import,
   `_request` name, no-scope response) = replaced by V1 `0f31097` → **DEPLOY SAFE**.
6. Vantra local branch state: `agent/task-207-mesh-scoped-mint` clean EXCEPT
   ` M TASK_25_REQUEST_UNLOCK_NOTIFICATION.md` = pre-existing parked doc from
   another task → **NEVER include in any deploy list** (repo precedent).

### DEPLOY LISTS (locked)
- **VANTRA (step 1, first):**
  `lib/meshcentral-api.ts`
  `app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts`
  → rsync → build as `vantra` user (full log to /root file, TSTP-immune,
  BUILD_ID rollback guard — recreate `deploy-vantra-relay.sh`, which was deleted
  in a task-205 script sweep, as `scripts/t207-vantra-deploy.sh`)
  → verify: BUILD_ID changed · :3300 200 · box route greps `scope` > 0.
- **SPACEWORKER (step 2, second)** via hardened `scripts/deploy-vps.sh`:
  `components/device-console.tsx`
  `lib/device-tools.ts`
  `tests/console-mesh-scope.test.ts`
  `tests/support-tickets.test.ts`
  → **device-onboarding.ts deliberately EXCLUDED (decision 3 above).**

### POST-DEPLOY VERIFY (in order)
1. Both BUILD_IDs changed; :3300 and :3500 and public 200; maintenance OFF.
2. Box mint route greps `scope` > 0; box spaceworker device-console greps
   `useIsMobileViewport` + `noopener,noreferrer`.
3. curl customer mesh-urls (login myrate619 / TestUser123) → expect scoped
   response; admin path → broad WITHOUT `scoped` flag (Task_147 by design).
   If the offline device breaks the live mint call, fall back to box-code grep
   + `journalctl -u vantra` (loud `scoped:false` log only fires when scope is
   present but tenant resolution fails).
4. Owner does the admin grant/test themselves (explicit instruction).

### QUEUE AFTER THIS
- CyberLab deploy for the other agent's work — owner will hand me the handoff
  when that agent finishes; deploy from `sw-lab` per the established cyberlab
  procedure (previous runs: TASK_CYBERLAB_UI1_DEPLOY_STEPS.md +
  TASK_CYBERLAB_EGRESS_DEPLOY_STEPS.md).
EOF
wc -l < "$F"
echo APPENDED_OK
