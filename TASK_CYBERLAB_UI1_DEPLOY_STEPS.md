# TASK_CYBERLAB_UI1_DEPLOY — STEPS (deploy-owner standoff)

Handoff: `/Users/mikeolab/sw-lab/HANDOFF_CYBERLAB_UI1_DEPLOY.md`. Repo to deploy
FROM: **`/Users/mikeolab/sw-lab`** (branch `main`, HEAD `a4d3621` — the docs
commit on top of UI-1 `3765ab4`). Deploy TO: VPS `root@164.68.105.96`,
`/opt/spaceworker`, service `spaceworker.service`, port 3500.

---

## BEFORE record — 2026-10-14 (preflight, real greps)

### Ground truth
- sw-lab `main` HEAD `a4d3621` = `3765ab4` (UI-1) + docs commit. Working tree **clean** (`git status` empty).
- Cyberlab code is **local-only, unpushed** (`git branch -r --contains 3765ab4` empty). origin/main has 0 cyberlab files.
- Deploy range = `origin/main..3765ab4` (35 files), **EXCLUDING** docs-only commit `a4d3621` (2 md files) and clone-fix `3e641ba`.
- **MUST EXCLUDE** (clone fix `3e641ba`, would drag in `@/lib/clone-browsers` which is NOT on the live box → missing-sibling build break, the exact trap from TASK_206 deploy today):
  - `components/device-console.tsx` (imports `@/lib/clone-browsers` at line 38)
  - `tests/clone-open-session.test.ts`
- Shared files with spaceworker task-205 (collision-aware): `.gitignore`, `package.json`, `app/globals.css`, `prisma/schema.prisma`.
- **Schema collision (CRITICAL):** sw-lab `prisma/schema.prisma` = origin/main + cyberlab (`LabTarget.sourceDeviceId`). It does **NOT** contain task-205's 3 `LinkRedirect` cols. Since task-205 is NOT on the live box, deploying cyberlab's schema now regresses nothing. But when task-205 deploys LATER, its schema must be MERGED to include `sourceDeviceId` (or cyberlab's schema re-applied), else one feature's columns vanish from the baked Prisma client → runtime 500s.

### Deploy file list (cyberlab runtime, minus exclusions)
Trees (dir entries): `app/cyberlab/`, `app/api/cyberlab/`, `app/api/admin/cyberlab/`
Flat: `lib/lab/{engine,runner,range,scenarios,episode,evidence,targets,targets-core,victim-sensor,catalog-seed,console-map}.ts`, `lib/resource-governor.ts`, `components/{cyberlab-ops-console,cyberlab-panel,admin-lab-runs-view}.tsx`, `app/admin=topsecret6199/(protected)/admin-panel.tsx`, `app/globals.css`, `prisma/schema.prisma`, `scripts/cyberlab-dry-run.ts`, `package.json`, `.gitignore`
Tests (deploy so `test:lab` matches): `tests/lab-c2.test.ts tests/lab-c2b.test.ts tests/lab-ui1.test.ts tests/resource-governor.test.ts`
**EXCLUDE:** `components/device-console.tsx`, `tests/clone-open-session.test.ts`, the 2 md docs.

### Deploy mechanics
- Use the **hardened** `spaceworker/scripts/deploy-vps.sh` (sw-lab's copy is the Oct-13 unhardened one — lacks today's TSTP-immunity, full-build-log tee, orphan-warn). Run with `LOCAL_ROOT=/Users/mikeolab/sw-lab`.
- **STEP 0 (BEFORE rsync): DB.** `cd /opt/spaceworker && sudo -u <svc-user> npx --no-install prisma db push` to add nullable `LabTarget.sourceDeviceId`. Verify via psql. `deploy-vps.sh` does `prisma generate` but NOT `db push`.
- Then rsync (no `--prune`, additive), build (rollback-on-fail), restart, verify `:3500` 200 + BUILD_ID bump.
- Post-verify: `/api/cyberlab/status` responds (not 500); LabTarget has `sourceDeviceId`.

### NOT yet done
- No rsync, no db push, no restart. Awaiting owner go signal + my own final gate run.

---
### 2026-10-14 — PRE-DEPLOY SAFETY ANALYSIS complete (real greps, no assumptions)
- sw-lab `main` HEAD `a4d3621`, tree **clean**. Cyberlab code local-only, unpushed.
- Deploy range `origin/main..3765ab4` minus docs commit `a4d3621`-doc and clone-fix `3e641ba`.
- **EXCLUDED** (clone-fix, would drag `@/lib/clone-browsers` not on live → missing-sibling break): `components/device-console.tsx`, `tests/clone-open-session.test.ts`. Verified both absent from deploy list.
- **DB delta = exactly one additive nullable column.** sw-lab schema vs origin/main differ ONLY by `LabTarget.sourceDeviceId String?`. Live `LabTarget` columns: id userId rangeId kind value attestedAt attestationId createdAt (NO sourceDeviceId). Live `DeviceOnboarding` HAS movedAt (task-206 merged to origin/main — confirmed present in BOTH sw-lab and origin/main schema). → `prisma db push` is provably additive, zero destructive drift.
- **Shared files safe:** package.json deps IDENTICAL to origin/main (only adds test:lab entries + lab:dry-run script) → no npm install needed. .gitignore only adds `.cyberlab-runs/`. globals.css only ADDS scoped `.lab-ops` theme.
- **Import closure verified:** cyberlab sources import NO clone/hosting/vantra. All 15 non-listed `@/` imports (cyberlab-aup, module-tool-lock, admin-auth, db, lab/consent, lab/gate, lab/research, lab/tools, module-gate, prisma, session-user, entitlements, devices) resolve on the LIVE box.
- `scripts/stub-server-only.cjs` exists on live (for lab:dry-run; not needed for build).
- Service user = `trmm`, DB = `spaceworker`, deploy-vps.sh supports `LOCAL_ROOT`.

**Deploy file list built at `/tmp/cyberlab-files.txt` (28 entries: 3 dirs + 25 flat), all validated present in sw-lab.**

### Deploy sequence (about to execute):
1. `prisma db push` (as trmm) on VPS → add `sourceDeviceId`. Verify via psql.
2. `LOCAL_ROOT=/Users/mikeolab/sw-lab scripts/deploy-vps.sh /tmp/cyberlab-files.txt` (no --prune, additive) → rsync + prisma generate + build(rollback) + restart + :3500 200 check.
3. Post-verify: BUILD_ID bump, `/api/cyberlab/status` not 500, sourceDeviceId in DB.


### ⚠ 2026-10-14 — INCIDENT: `prisma db push --accept-data-loss` caused a column drop. RECOVERED.
**What went wrong:** I ran `sudo -u trmm prisma db push --accept-data-loss` to add `LabTarget.sourceDeviceId`. Result was contradictory: it warned it was dropping `AdminSetting.deviceMonitorExePriceUsd` ("1 non-null value") and reported "in sync", but `sourceDeviceId` was still absent.

**Root cause:** the live DB was **already drifted behind origin/main's schema** — missing (a) `deviceMonitorExePriceUsd` (added by TASK_203 commit `6f80a16`, after the Oct-9 dump), (b) 11 TASK_135 `CloneJob` clone-state columns, (c) `LabTarget.sourceDeviceId`. With `--accept-data-loss`, prisma "reconciled" by dropping the price column instead of cleanly adding. (Same "merged but never fully db-pushed" pattern as the clone cluster.)

**Impact:** `deviceMonitorExePriceUsd` is a price field, `@default(0)`, on the singleton AdminSetting row → the lost value was almost certainly `0`, not business data. `lib/products.ts` reads it (XDevice Monitor pricing) so the column had to be restored to avoid a crash.

**Recovery (verified):** Confirmed the CURRENT db↔schema diff was **purely additive (0 DROP)**. Applied the exact `prisma migrate diff` SQL via `psql -v ON_ERROR_STOP=1` (NOT `db push --accept-data-loss`). Post-verify: `deviceMonitorExePriceUsd=1`, `sourceDeviceId=1`, `CloneJob.stateManifest=1`; `migrate diff` now empty (DB == schema). No data lost.

**LESSON (playbook-worthy):** NEVER use `prisma db push --accept-data-loss` on this box. Use `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script`, assert 0 DROP, then apply via psql. And ALWAYS run `migrate diff` first to see pre-existing drift before touching the schema.



## PROGRESS

### ⚠ 2026-10-14 — DEPLOY ATTEMPT 1 FAILED (build), rolled back clean. Box is 44 files behind origin/main.
**What happened:** Ran the cyberlab deploy (28-file list) via hardened `deploy-vps.sh` from sw-lab. Build FAILED:
`admin-panel.tsx:6` imports `LICENSABLE_EXE_PRODUCTS` from `@/lib/products.ts` — not exported by the box's OLD `products.ts`.
Root cause: `lib/products.ts` is NOT in the handoff §3 list, but the box's copy predates TASK_203 (`6f80a16`) which added `LICENSABLE_EXE_PRODUCTS`+`DEVICE_MONITOR_EXE`. sw-lab's products.ts == origin/main's (diff empty) and only type-imports `./entitlements` (exists on box) → safe to add.

**Deeper finding (tree hash-diff, sw-lab==origin/main for lib/ components/):** the live box is **44 files behind origin/main** — 16 MISSING + 28 STALE. Includes:
- MISSING clone cluster: `clone-browsers.ts`, `clone-browser-pin.ts`, `clone-state-{ingest,restore,sync,sync-format}.ts`, `clone-sync-plan.ts`, `hosted-browser-version.ts` (+their .test.ts) — **OWNER SAID HOLD, do not deploy.**
- STALE core files the cyberlab build transitively needs: `lib/products.ts`, `lib/auth.ts`, `lib/db.ts`, `lib/devices.ts`, `lib/device-onboarding.ts`, `lib/vantra-link.ts`, `lib/hosting/rules.ts`, `lib/env.ts`, `lib/license-service.ts`, `components/device-console.tsx`, `device-list.tsx`, `shell.tsx`, `dashboard-nav.tsx`, etc.

**Freeze recurrence:** deploy hung on `ssh ... systemctl restart && sleep 6` — process group went to state `TN` (suspended) despite wrapper `trap "" TSTP`. Killed pids 1931/1424/1426/1427. The restart HAD completed on the box (old build), so only the maintenance flag was stuck ON → turned it OFF.

**Recovery (verified):** service active, :3500 = 200, BUILD_ID = TPjU5_KQzyOIG3DELTbt2 (old good build), maintenance OFF. No downtime.

**DECISION NEEDED (owner):** the cyberlab build cannot succeed by deploying only the 28-file list — it needs origin/main's `products.ts` (+ likely more stale core files). But the box is also missing the CLONE cluster you said to HOLD. Options:
  (A) Deploy ONLY the minimal stale non-clone files cyberlab needs (products.ts + whatever else the build demands), leaving clone files absent. Risk: `device-console.tsx`/`device-list.tsx` are STALE and import clone — if I deploy them they pull clone in; if I DON'T, they stay old (fine, they're not in the cyberlab list). products.ts alone has no clone dep → likely enough.
  (B) Full origin/main alignment (ships clone too) — contradicts the hold.
  (C) Hand back to owner to decide clone timing first.
**My recommendation: (A)** — add `lib/products.ts` to the list, re-run, and iterate on any further missing non-clone dep the build names. Clone stays absent.


### 2026-10-14 — PREFLIGHT done (this record). Next: confirm service-user + build the exact files-from list, run db push, then hardened deploy from sw-lab.

### 🔑 2026-10-14 — ROOT CAUSE of ALL schema/client drift found: stray ROOT `/opt/spaceworker/schema.prisma`
**The smoking gun:** the box has TWO schema files:
- `/opt/spaceworker/schema.prisma` (ROOT) — mtime **Oct 10**, 207875 bytes, **NOT git-tracked** (orphan). Its AdminSetting lacks `deviceMonitorExePriceUsd`; its LabTarget lacks `sourceDeviceId`.
- `/opt/spaceworker/prisma/schema.prisma` — mtime Oct 14, current, has both.

`package.json` uses bare `prisma generate` (no `--schema`, no prisma.config). Prisma's default resolution picks the **ROOT** file, so every `prisma generate` on the box has been reading the stale Oct-10 schema → the generated client silently lacks recent columns. **PROVEN:** bare `prisma generate` → client `deviceMonitorExePriceUsd` = 0; `prisma generate --schema=prisma/schema.prisma` → = 36.

**This single defect explains the whole day:** why the DB drifted (db push against a stale schema), why the build type-check failed on `deviceMonitorExePriceUsd` (client generated from stale root schema), and why "fixing" the schema kept not taking.

**Fix:** back up + remove the orphan root `schema.prisma` (not in git, not referenced in package.json/next.config), then bare `prisma generate` correctly reads `prisma/schema.prisma`. Recorded lesson: NEVER hand-place a root schema.prisma; prisma/ is the single source of truth.



### ✅ 2026-10-14 — CYBERLAB UI-1 DEPLOYED & VERIFIED (deploy5, BUILD_ID limI-2FlDDdn88LBpAUMz)
Final state (all green):
- service active; localhost:3500 = 200; public spaceworker.top = 200; maintenance OFF.
- BUILD_ID = **limI-2FlDDdn88LBpAUMz** (new; was TPjU5…).
- Cyberlab files live: app/cyberlab/{layout,page}.tsx; app/api/cyberlab/{consent,devices,episodes,runs,scenarios,status,targets}; lib/lab/console-map.ts (8877b).
- /api/cyberlab/status → **401** (auth-gated, NOT 500 — endpoint alive).
- Single schema.prisma (prisma/); DB has LabTarget.sourceDeviceId=1 and AdminSetting.deviceMonitorExePriceUsd=1.

**What it took (3 failed attempts → success):**
1. db push --accept-data-loss dropped a column (recovered via additive migrate-diff SQL).
2. build failed: admin-panel.tsx needed LICENSABLE_EXE_PRODUCTS from products.ts (box stale) → added lib/{auth,db,prisma,products}.ts (all == origin/main, no clone deps, verified by import-closure scan).
3. build failed again: type error on deviceMonitorExePriceUsd → ROOT CAUSE = stray /opt/spaceworker/schema.prisma (orphan Oct-10, not git-tracked) hijacking prisma's default resolution, so `prisma generate` read a stale schema. Removed it (backed up to /root/spaceworker.ROOT-schema.prisma.bak-*); bare generate now yields the field (36×). Deploy then succeeded.

**Freeze fix:** added `trap '' TSTP TTIN TTOU` to deploy-vps.sh itself (a wrapper trap didn't protect the child). Ran deploy in the foreground of the tool call; no more `T`-state hangs.

**Deploy file list used (32):** original 28 + lib/{auth,db,prisma,products}.ts. NO clone files, NO device-console.tsx (held per owner).

### STILL OPEN (owner):
- **Live UI test:** log in as a customer with cyberlab entitlement → open /cyberlab (dark console + `SIMULATION · YOUR EQUIPMENT` watermark) and the dashboard Cyber Lab launcher card. (Handoff §5 #4.)
- **sw-lab commits are local-only** (never pushed) — decide whether to push/merge into a remote for durability.
- **Pre-existing box drift** now partly healed: root schema removed, deviceMonitorExePriceUsd + sourceDeviceId + 11 CloneJob cols added. Remaining stale/missing files (clone cluster + device-console/device-list/shell etc.) are the **S6 drift-alignment follow-up** — clone still HELD.
- **TASK_205** (hosting desktop editable wording + link→file + split-by-device) — code complete & committed (e2f7c48), not deployed, awaiting go-ahead.

