# PROMPT — NEXT FEATURE AGENT (TASK_176: nested launcher, ONE folder rename drives both levels)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md sections 4 + 5 traps.
- `TASK_176_NESTED_LAUNCHER_SINGLE_RENAME.md` (read it fully — it holds
  the owner's single-rename rule + the exact edit points).
- Rules: explicit git add of paths only (TASK_133 is the owner's, never
  touch it); commit with -F file; never print secrets; never edit .env;
  never git stash.
- State: spaceworker main at `f27fa8b` (TASK_175 desktop-only gate
  shipped). The work below spans THREE repos — scope per repo is in §2.

## 1. THE TASK (owner-directed 2026-10-06)

The launcher EXE sits in ONE renamed folder inside the installer zip
(`<inner>/Launcher.exe`). Nest it one level deeper so it lives in the
INNER folder: `<inner>/<inner>/Launcher.exe`. The public-link mint UI
keeps all three rename fields with NO changes — the ONE folder name the
user types applies to BOTH levels (e.g. `acme` →
`acme/acme/Launcher.exe`).

## 2. THE BUILD (additive-only, no migration)

1. **Generator** (`/Users/mikeolab/vantra-installer/generator/src/launcher-build.ts`
   — the ONLY logic change): in `runLauncherBuild`, after `clean()`,
   derive `nested = innerFolder + "/" + innerFolder` and use it for the
   three zip entries (`:282-289`), the `-LauncherSubFolder` arg (pass
   `innerFolder + "\\" + innerFolder`, `:259-260` — no `.ps1` logic
   change), and the `names:` object for `validateLauncherBuild`.
   `launcher-validate.ts`: assert the doubled path. `launcher.c`: NO
   change (sibling invariant kept). PDF follows the exe into the inner
   folder. `Update.lnk` stays at the zip root.
2. **Vantra** (`/Users/mikeolab/vantra`): NO CHANGE expected — the
   `installer` block forwards `innerFolder` opaquely; the doubling
   happens inside the generator. Only update a test expectation if one
   pins the entry list.
3. **SpaceWorker** (`/Users/mikeolab/spaceworker`): NO UI CHANGE —
   `device-list.tsx` keeps all three fields; `lib/vantra-link.ts` +
   `install-link/route.ts` unchanged. The single `innerFolder` flows
   through and the generator doubles it.

Do NOT touch: resolver/redirect, wallet/grants, TASK_133, tier split.

## 3. VERIFY (before docs)

- Zip entries exactly `{ Update.lnk, acme/acme/Launcher.exe,
  acme/acme/agent.bin }` for `innerFolder: "acme"`; bridge args contain
  `acme\acme\Launcher.exe`. Blank → `launcher/launcher/`. Bad name →
  `launcher/launcher/` (drop rule, never 400). PDF in inner folder.
- `test:vantra` + hosting/wallet/support suites, `tsc --noEmit`,
  `CI=true npm run build`. Live: mint a real zip, confirm nested path
  in Explorer, VM install checks in with no GUI dialog.

## 4. DOCS + HANDOFF (spaceworker repo, one commit)

- SENIOR_HANDOFF.md: section 6 state, section 7 queue (strike 0b,
  TASK_176 done), section 12 log entry.
- New TASK_176_NESTED_LAUNCHER_BUILD.md (entries, bridge args,
  verification). The scope doc stays as-is.
- PROMPT_NEXT_VERIFICATION_AGENT.md belongs to the verifier — leave it.
- Commit docs + code explicitly (git add paths, -F file), push main.
  Deploy only if spaceworker code changed (expected: none — generator
  + vantra deploy separately per their own pipelines).

## 5. PARKED (do NOT build — queue only)

1. Grant fix (row 0c, SMALL, root-caused §7): nullable-admin.
2. Wallet W6 EXE-from-wallet (after grant fix). Big — do not start.
3. Tier split TASK_174 (row 0d, LARGE) — parked until W6 lands.

## 6. Report back

1. File diffs per repo, entry-list proof, bridge-args proof, live zip proof.
2. Docs commit SHA + push proof; parked items queued with numbers.
3. Honest unverified list.
