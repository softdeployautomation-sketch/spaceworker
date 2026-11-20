# TASK_135 (clone cluster resync) — STEPS

Running BEFORE/AFTER log. Compaction-safe: read this + the box state to resume.

---

## GOAL
Resync the box's clone cluster up to origin/main. Box was running an OLDER clone
snapshot: 10 of 17 clone libs, and `device-console.tsx` had the clone UI deliberately
stripped ("clone-hold" in cb8ec7b). The relay-race fix (Vantra `buildRelayProbe` polling)
is already deployed; this is the separate spaceworker-side clone cluster catch-up.

## CRITICAL CONSTRAINTS (verified against the live box)
- **Box has TASK_206 live**: `device-console.tsx` (movedAt×2) + `lib/devices.ts`,
  `lib/device-onboarding.ts`, `lib/vantra-link.ts` are AHEAD of origin/main. A blind
  resync of these REGRESSES the quarantine rework. DO NOT rsync them from origin/main.
- **Box has TASK_205 live** (hosting links). Same rule for `lib/hosting/*`,
  `app/r/[token]/route.ts`, `components/hosting-panel.tsx`.
- **`origin/main`'s `device-console.tsx` == merge-base `a1704b4a`** (main never advanced
  it). It has the FULL clone UI (clone-browsers×2) and NO movedAt. The box's cb8ec7b
  stripped clone UI and added the 2-line movedAt threading.
- **Engine binaries**: box `hack-relay.exe` (5f359b5e) is NEWER than local (2880ce); relay
  Go source is byte-identical across checkouts → overwriting is a no-op/downgrade.
  DECISION: update only `install-relay.ps1` (real bind-wait fix), PRESERVE box binaries.

## THE MERGE (done, verified) — /tmp/dc-final.tsx
Correct 3-way result = origin/main device-console.tsx (clone UI) + port 2 movedAt lines:
- type block: insert `    movedAt: string | null;` between `stayOnDoneAt` and `releasedAt`
  (anchor: `    stayOnDoneAt: string | null;\n    releasedAt: string | null;`)
- onboardingView call: insert `      movedAt: row.movedAt,` between the two
  (anchor: `      stayOnDoneAt: row.stayOnDoneAt,\n      releasedAt: row.releasedAt,`)
Script: `scripts/clone-build-dc.sh`. Verified: clone-browsers=2, movedAt present (lines
96 + 2033), 0 conflict markers. (movedAt substring count=3 because `row.movedAt` has it twice.)

## DEPLOY LIST (16 files) — /tmp/clone-files.txt  (GUARD-passed: no keep-set/schema/env/hosting)
1. lib/clone-browser-pin.ts      9.  lib/clone.ts
2. lib/clone-browsers.ts         10. lib/clone-transport.ts
3. lib/clone-state-ingest.ts     11. lib/clone-hosted-launch.ts
4. lib/clone-state-restore.ts    12. lib/clone-live-capture.ts
5. lib/clone-state-sync-format.ts 13. lib/browser-profiles.ts
6. lib/clone-state-sync.ts       14. lib/browser-runtime.ts
7. lib/clone-sync-plan.ts        15. lib/cdp.ts
8. lib/hosted-browser-version.ts 16. components/device-console.tsx (MERGED)

Import-closure check (`scripts/clone-assemble.sh`) confirmed the clone closure needs ONLY
these clone libs — NO core redeploy (box's devices.ts/db.ts/env.ts/prisma.ts already export
`deviceStatus`, `recordAgentActionAudit`, `db`, `Env`/`env`, `prisma`).

---

## ✅ 2026-10-15 — CLONE RESYNC DEPLOYED & VERIFIED (BUILD_ID 7hzgmeVMp_wXtOe47TcBr)

Deployed via `scripts/clone-run.sh` → `deploy-vps.sh /tmp/clone-files.txt` (16 files).

**Verification (all pass):**
- service active · :3500 = 200 · public spaceworker.top = 200 · **maintenance OFF**
- **BUILD_ID `7hzgmeVMp_wXtOe47TcBr`** (new; was fsMwhzRBaQUP6lGbh1KQF)
- **clone*.ts count = 17** (was 10) — all 7 missing libs landed (clone-browsers, clone-browser-pin,
  clone-state-ingest/restore/sync/sync-format, clone-sync-plan) + hosted-browser-version + browser-profiles/runtime/cdp
- **device-console.tsx clone-browsers = 2** (clone UI wired) **AND movedAt = 2** (TASK-206 preserved) ✓
- **devices.ts movedAt still live = 1** — no TASK-206 regression
- runtime survived: .env / .next / node_modules / static/maintenance.html all ok

### Incident + recovery (logged for the playbook)
- The deploy orchestrator (clone-run.sh) was killed mid-run by the shell-integration (my stray ^C +
  the tool terminating the foreground command). The box build had already **completed successfully**
  (no errors, valid .next, new BUILD_ID written, .next.prev rollback copy kept), but the script died
  BEFORE its restart + maintenance-off steps → **maintenance stuck ON**, service still on old build.
- Recovery (`scripts/clone-recover.sh`): confirmed build clean (0 errors, .next/server+.next/static OK),
  then `systemctl restart` to load new build + `rm /var/www/sw-maintenance.on`. Verified green above.
- LESSON (reinforces the earlier deploy-vps.sh hardening): a killed orchestrator leaves maintenance ON.
  The restart+maintenance-off must be idempotent and re-runnable independently of the build — which is
  exactly what clone-recover.sh now is. Future deploys: run the orchestrator with `setsid`/`nohup …
  </dev/null &` AND a trap, or accept that a mid-run kill needs clone-recover.sh.

### NOT done (engine binaries) — per decision
- engine-dist/install-relay.ps1 bind-wait NOT rsynced yet (deferred). Box binaries preserved (newer).
  The primary relay fix (Vantra buildRelayProbe polling) is already live, so this is optional hardening.

### Still open (owner)
- Live test: open a device console (clone UI should render), run clone setup, confirm relay probe reads "up".
- Merge `agent/task-205-link-routing-wording` + clone working-tree changes into a branch/PR; the clone
  libs are currently uncommitted in the working tree (deploy rsyncs working tree, doesn't need a commit).


Working tree: on branch `agent/task-205-link-routing-wording`. Clone libs pulled from
origin/main into working tree via `git checkout origin/main -- <file>`; merged
device-console.tsx copied to `components/device-console.tsx`. (Uncommitted — fine, deploy
rsyncs working tree.)

## CURRENT STATE (as of last check — deploy NOT yet landed)
- Box: clone*.ts count = 10 (the 7 new ones NOT there yet). device-console clone-browsers=0,
  movedAt=2 (unchanged). BUILD_ID = fsMwhzRBaQUP6lGbh1KQF (TASK_205). service active,
  :3500 = 200. Site healthy, nothing broken.
- Backups on box: /root/device-console.tsx.bak-1792030906 (pre-merge) +
  /root/engine-dist.bak-1792030906.tar.gz.

## REMAINING (the actual deploy — blocked only by shell-integ killing background jobs)
1. Run the deploy. RELIABLE METHOD: the run_commands tool leaves a FOREGROUND command
   running past its 300s window (that's how t205/cyberlab succeeded). Background nohup gets
   killed when the tool's shell returns — DO NOT rely on nohup/&.
   `cd /Users/mikeolab/spaceworker && bash scripts/clone-run.sh > /tmp/clone-run.log 2>&1; echo RC=$?`
   (clone-run.sh has `trap '' TSTP TTIN TTOU`, prints pre-flight health + before BUILD_ID,
   then runs `bash scripts/deploy-vps.sh /tmp/clone-files.txt`.)
2. Build is the real compile-test (rollback-on-fail in deploy-vps.sh). If it fails, the
   script rolls back .next and site stays healthy — read /tmp/clone-run.log + /root/last-build.log.
3. On success verify (scripts/t205-verify.sh pattern): new BUILD_ID, :3500 200, maintenance
   OFF, clone*.ts count = 17, device-console clone-browsers=2 AND movedAt=2, service active.
4. Engine: rsync ONLY engine-dist/install-relay.ps1 to box (preserve binaries) unless user
   insists on full overwrite.
5. Post-deploy live test (owner): open a device console, confirm clone UI renders; run a
   clone setup and confirm the relay probe now reads "up" (Vantra polling fix).

## SCRIPTS CREATED (all in /Users/mikeolab/spaceworker/scripts/)
clone-scope.sh, clone-compat.sh, clone-merge-dc.sh, clone-build-dc.sh, clone-assemble.sh,
clone-filelist.sh, clone-run.sh. Temp: /tmp/dc-{base,ours,theirs,final}.tsx,
/tmp/merged-schema.prisma (task-205, already deployed), /tmp/clone-files.txt.
