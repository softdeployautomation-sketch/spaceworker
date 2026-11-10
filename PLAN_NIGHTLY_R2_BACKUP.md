# PLAN — Nightly R2 backup hardening (2026-11-10)

Status: COMPLETE — deployed and verified 2026-11-10.

## Objective
Keep the nightly Cloudflare R2 backup working, and make it protect **everything that matters**:
all four Postgres databases (spaceworker, vantra, tacticalrmm = devices/agents, meshcentral =
mesh nodes/groups), Postgres roles/globals, the critical config/secrets needed to restore, and the
small on-disk user data. Fix the Vantra admin page that currently reports "last run: Never", and add
an independent staleness alarm.

## BEFORE — verified evidence (2026-11-10)
- `db-backup.timer` **enabled + active**; last trigger **2026-11-10 03:18:09 CET**; next
  **2026-11-11 03:17:51**.
- `db-backup.service` **Result=success**; journal Nov 7–10 shows
  `OK: vantra backed up (40K)` → `OK: spaceworker backed up (30M)` → `completed successfully`.
- R2 bucket `instaweb-db-backups`: 63 objects / 781 MB; **daily** dumps `20261012` → `20261110`
  under `vantra/` and `spaceworker/` only. No `tacticalrmm/`, no `meshcentral/`.
- Website "last run: never" root cause: `vantra/lib/background-jobs.ts` `parseDate()` calls
  `Date.parse("Tue 2026-11-10 03:18:09 CET")`. Probed on the box with Node 24 →
  **`NaN`** → `null` → the UI renders "Never". Display bug, not a backup failure.
- Vantra deploy workflow `.github/workflows/deploy.yml` still targets the **dead** old host
  `164.68.105.96` (3 places); local `main` is 1 commit ahead of `origin/main`.
- Box: 156 GB free disk. `sudo -u postgres pg_dump -d tacticalrmm` and `-d meshcentral` both
  proven readable. `systemd-analyze calendar "*-*-* 03:17:00 UTC"` supported.

## Agreed scope (owner answers)
- DBs: spaceworker, vantra, tacticalrmm, meshcentral + `pg_dumpall --globals-only`.
- Config/secrets in the private R2 bucket: `/opt/*/.env`, TRMM settings/NATS, MeshCentral
  config+certs, nginx, our systemd units, letsencrypt.
- Small user data: hosted-sites, cyberlab-contexts, cyberlab-sessions.
- Excluded: device screenshots (126 MB, sensitive), installers/build artifacts (~400 MB).
- Independent 6-hour staleness alarm: yes.

## Phases
### P0 — plan file (this file) — DONE (written before edits)
### P1 — safety snapshots on the box — DONE
- [x] `/opt/backups/backup-databases.sh` → `/root/backup-databases.sh.bak-20261110-155003`
- [x] `/etc/instaweb-backup.env` → `/root/instaweb-backup.env.bak-20261110-155003` (mode 600, never printed)

### P2 — new backup script + units (repo `deploy/`, installed on box) — DONE
- [x] `deploy/backup-databases.sh` (4 DBs, globals, config tar, data tar, R2 upload, 30d prune,
      manifest `_status/last-success.json`, Telegram on failure)
- [x] `deploy/db-backup.service` + `.timer` (ExecStart repo path; `OnCalendar=*-*-* 03:17:00 UTC`)
- [x] `deploy/backup-health.sh` + `db-backup-health.service/.timer` (6-hourly staleness check)
- [x] `bash -n` both scripts
- [x] install box-side, run once: service `Result=success`, 7 parts, all uploaded
- [x] `gzip -t` all 7 local archives OK
- [x] restore drill: vantra 29 tables/9.9MB, spaceworker 97/316MB, tacticalrmm 66/17MB,
      meshcentral 8/18MB — all restored into `backup_verify_*`, then dropped

### P3 — git durability
- [ ] commit `deploy/*` + this plan on `main`, push (no SpaceWorker app deploy needed)

### P4 — Vantra UI tells the truth
BEFORE note: edit `lib/systemd-time.ts` (new pure parser), `lib/background-jobs.ts`
(import it, run `systemctl` with `TZ=UTC`, refresh db-backup copy, add health row),
`tests/systemd-time.test.ts` (new), `.github/workflows/deploy.yml` (3 dead-host lines).
- [x] `lib/systemd-time.ts` (TZ=UTC + regex → Date.UTC) + use in `lib/background-jobs.ts`
- [x] add `db-backup-health` job + fix schedule/description copy
- [x] `tests/systemd-time.test.ts`; `tsc` 0, eslint 0, 5/5 new tests pass
- [x] full Vantra suite 170/175: 4 move-flow failures reproduced from the owner's
      uncommitted `lib/trmm-install-command.ts` (the same tests pass on clean HEAD);
      `wol-scripts` also fails on clean HEAD -> both pre-existing, none from this change
- [x] fix `.github/workflows/deploy.yml` old host → `207.244.224.57` (3/3)
- [x] commit + push main; **PAUSE for owner GO before dispatching deploy**
- [x] dispatch verified: run `42853516317` success; secret works; BUILD_ID
      `TYcHdo0D-kUcMehNJmW2W` -> `_fVCFE5Fht2s_OzVZyTh7`; `vantra` active; `/` 200

### P6 — health alarm — DONE
- [x] install/verify timer; live run `OK: last full backup 0h ago; all four DB prefixes populated`
- [x] dry-run with a missing bucket produced the STALE alert path and sent nothing
- [x] timer active, next `2026-11-10 19:42 CET` (18:42 UTC)

### P7 — docs + report — DONE
- [x] HOW_WE_MOVE_FAST §0a "Nightly backup" block (verify + restore drill)
- [x] verification pin 18 + 2026-11-10 baseline note
- [x] SENIOR_HANDOFF §6 newest-state paragraph + §12 log entry
- [x] this file AFTER

## Verification commands (planned)
- `systemctl show db-backup.timer db-backup.service --no-pager -p ...`
- `journalctl -u db-backup.service -n 100`
- `rclone lsf r2backup:$R2_BUCKET/{spaceworker,vantra,tacticalrmm,meshcentral,globals,config,spaceworker-data}`
- `gzip -t` every new local archive
- restore drill in `backup_verify_*` scratch DBs
- Vantra: `npx tsc --noEmit`, `npx tsx --test tests/*.test.ts`, authenticated API probe

## Risks / rollback
- Backup runs read-only against DBs; no app downtime.
- Box-side rollback = restore `/root/backup-databases.sh.bak-*` + previous units, daemon-reload.
- Secrets are never printed or committed; they stay in `/etc/instaweb-backup.env`.
- Vantra deploy = brief service stop → owner GO required (P4 pause).

## AFTER — execution log (append per phase)
- P1: backups saved `/root/*.bak-20261110-155003` (root-only).
- P2 run 2026-11-10T15:53Z (the reloaded persistent timer fired once, which was useful):
  `vantra` 44K, `spaceworker` 30M, `tacticalrmm` 740K, `meshcentral` 440K, `globals` 4K,
  `config` 72K, `spaceworker-data` 204K, manifest `_status/last-success.json`.
  Timer now `NextElapse 2026-11-11 04:18:57 CET`; health timer next `2026-11-10 19:42:29 CET`.
  Note: explicit UTC schedule means 03:17 UTC = 04:17 CET in winter (one-hour shift vs old local timer).
- P2 proof: restore drill counts above — dumps are genuinely restorable, not just uploaded.
- P4: live `TZ=UTC systemctl show` strings parsed correctly end-to-end
  (`Tue 2026-11-10 15:53:43 UTC` → `2026-11-10T15:53:43.000Z`); blank/`n/a` → null.
  Also stopped systemd's default `Result=success` from rendering a green badge
  before a job has ever run.
- P6: health timer installed/active; live check OK; alert path proven with
  `R2_BUCKET=...doesnotexist --dry-run` (exit 1, no Telegram sent).
- P7: docs updated; SpaceWorker `main` `1b2247e` (code) + this docs commit, Vantra
  `main` `2c1bde4`; Vantra push-build green.
- P4 deploy (owner GO 2026-11-10): run `42853516317` **success**; BUILD_ID
  `TYcHdo0D-kUcMehNJmW2W` -> **`_fVCFE5Fht2s_OzVZyTh7`**; `vantra` active; `/` **200**.
  Authenticated API probe (localhost, real admin login): `db-backup` ->
  `lastRunAt=2026-11-10T15:53:43.000Z`, `nextRunAt=2026-11-11T03:18:57.000Z`,
  `result=success`, `active=true`; `db-backup-health` row present, active, next
  `2026-11-10T18:44:26.000Z`. **The page's "Never" is fixed.**
- Out-of-scope finding: `vantra-telegram-device-check.timer` and
  `vantra-telegram-vps-check.timer` do not exist on the rebuilt box (not in any
  `deploy/` either); the page now honestly shows them inactive. Owner to decide.
