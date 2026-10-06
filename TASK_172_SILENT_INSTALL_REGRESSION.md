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

## 3. Fix (ssh, not a repo commit)

1. Back up + edit ONE live file:
   `/opt/vantra-installer/generator/src/install-command.ts` — append
   `` `--silent`, `` after the features-map line (byte-identical to local
   lines 51-60). Keep the FIX 4 comment block.
2. `systemctl restart vantra-msi-generator` (runs `tsx src/server.ts`,
   no build step). Assert active + clean journal.
3. Rollback: restore backup + restart.

## 4. Verify

- Live grep shows the `--silent` argv line; service active.
- Mint a test zip via the Spaceworker public flow; embedded enrollment
  command ends in `--silent`. GUI-silence needs a Windows VM — SIMULATION
  unless owner confirms on hardware.

## 5. Parked follow-up (TASK_173 candidate)

Owner wants the launcher in a SECOND folder nested inside the first, with
the .lnk calling it at the right path. Needs scoping (launcher.c, lnk
target, generator innerFolder contract, Vantra parity). Fix silent FIRST,
then scope this.
