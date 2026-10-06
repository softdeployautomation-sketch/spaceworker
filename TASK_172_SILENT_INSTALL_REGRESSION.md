# TASK_172 — P0 silent-install regression (live generator missing FIX 4)

Owner report (2026-10-06): the Spaceworker zip installer shows the
TacticalRMM GUI dialog during install/enroll — a bug fixed long ago in the
vantra-installer repo but still present in Spaceworker zips.

## 1. Root cause — one sentence

The live generator at `/opt/vantra-installer/generator/src/install-command.ts`
(VPS, deployed by copy, NOT a git repo) predates FIX 4: its
`buildEnrollmentCommand()` ends argv at the features map with NO `--silent`
line, so every zip it mints enrolls WITH GUI dialogs.

## 2. Evidence (this session, over ssh — not inferred)

- Reference: `vantra-installer` commit `e148ff5` (FIX 4) appends `--silent`
  as the LAST argv (generator/src/install-command.ts:59). Local
  `~/vantra-installer` installer-dev HAS it; `origin/main` now carries all
  three fix commits (`e148ff5`, `ccb129a`, `8fb69d8`) since the repo went
  public.
- Live: `grep -n silent` on the VPS file hits comments only (lines 36/57);
  the return array ends at `...features.map(...)` with no `--silent`.
- FIX 5 PDF auto-open IS live (live routes.ts ~36 pdf hits, same shape as
  local) — owner confirmed PDF was fixed post-merge. No PDF work.
- Vantra web side (`lib/zip-generator.ts`, `lib/sw-installer-names.ts`) at
  parity via TASK_121 + TASK_125. No web change needed.

## 3. Fix (ssh, not a repo commit) — DONE 2026-10-06

1. Backed up + overwrote ONE live file:
   `/opt/vantra-installer/generator/src/install-command.ts` — ported local
   installer-dev file (FIX 4 `e148ff5`) byte-identical (md5
   `00ef606a22342c9fba6405d8471d603c` both ends). Backup:
   `install-command.ts.bak.TASK172_20261006_163032`. Rollback: restore
   backup + restart.
2. `systemctl restart vantra-msi-generator` → active (PID 115516, since
   2026-10-06 16:31:17 CEST, clean journal; runs `tsx src/server.ts`,
   no build step).

## 4. Verify

- Live grep shows the `--silent` argv line (lines 33/35/42/59/64);
  service active (2026-10-06 16:31:17 CEST); live functional proof:
  `buildEnrollmentCommand({...})` ends in `--silent` (run on the box via
  `node --import tsx`).
- **Independent verifier re-run 2026-10-06:** md5 `00ef606a22342c9fba6405d8471d603c`
  still matches both ends; `vantra-msi-generator` active, same PID 115516 /
  same timestamp (no restart needed); journalctl `-p err` empty; probe:
  `"... --agent-type server --auth TOKEN --rdp --ping --power --silent"` +
  `ENDS_SILENT:true`; `routes.ts:668` builds that same `enrollmentCommand`,
  embedded at `:775` (`enroll:`) and `:812` (`installCommand:`).
- Spaceworker gates (same session): tsc clean; wallet 47/47;
  wallet-topup + wallet-route 38/38; vantra-link-installer 68/68;
  hosting 338/338; idle 23/23; support 49/50 — the single fail is
  TASK_166 "read cursor only ever moves FORWARDS" (`:1144`, 1ms
  wall-clock vs fake-clock race: expected `...047`, got `...048`),
  untouched by this fix (commit `ccd8293` is docs-only; `git diff
  2a6ed68..HEAD` on support files is empty; last support commit
  `892e209`). CI build exit 0; prisma valid, no migration.
- Verifier to mint a test zip via the Spaceworker public flow; embedded
  enrollment command must end in `--silent`. GUI-silence needs a Windows
  VM — SIMULATION unless owner confirms on hardware.

## 5. Parked follow-up (TASK_173 candidate)

Owner wants the launcher in a SECOND folder nested inside the first, with
the .lnk calling it at the right path. Needs scoping (launcher.c, lnk
target, generator innerFolder contract, Vantra parity). Fix silent FIRST,
then scope this.
