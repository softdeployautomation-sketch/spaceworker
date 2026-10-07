# PROMPT — NEXT VERIFICATION AGENT (TASK_181 device wrapper — verify the P0a→P5 ship, then close out)

TASK_181 implementation is COMPLETE through P5 as of 2026-10-07 (owner directed: "write the
steps and lets implement"). Your job: independently verify what shipped, run what's still
open, and close the task out. Source of truth: **`TASK_181_STEPS.md`** (every step + raw
evidence + the PRE-COMPACT SNAPSHOT) · scope: `TASK_181_DEVICE_WRAPPER_EXE.md` · playbook
(binding): `HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4/§6 live evidence). TASK_133
is the owner's — never touch it. Never git stash; never edit `.env`. Money/UI commits stay
separate; REJECT any doc/test/commit containing live secrets (placeholders only).

Start: `git log --oneline -5` in `/Users/mikeolab/spaceworker` (main, pushed through
`672c0bd`+ — record `git rev-parse HEAD`). The box build under test is BUILD_ID
`qOhtBtkIXCxhsWeEjrz1p200` (2026-10-07 21:21 +0200) — confirm before assuming.

## 1. THE THREE OWNER ASKS (each already has evidence in the steps file — re-prove, don't trust)

1. **Admin grant (the "grant bug"):** `SENIOR_HANDOFF.md` §7 row 0c = CLOSED. Re-run
   `npx tsx --test tests/wallet-grant-route.test.ts` (null-adminId route tests) and, live,
   one admin grant on a disposable user → balance +X, `admin_grant.adminId IS NULL`,
   **JSON never HTML** (playbook §4 harness pattern; DELETE the harness from the box after).
2. **Admin tier-3 grant UI:** admin panel Users tab shows **"XDevice 30d"** (or **"+30d
   XDevice"** when already tier 3) next to the existing grant buttons → POST
   `/api/admin/users/[id]/grant-premium {tier:3}` → 200, `tier===3`, ~30-day term returned,
   second grant STACKS (later expiry). Client chunk greps `30d XDevice`
   (`3ier_oz-u5gbm.js` at last check); server chunk greps `grantXDevice`.
3. **Wrapper payment:** `POST /api/wallet/spend {product:"xdevice"}` on a funded tier-1 →
   200, `chargedCents === xdevicePriceUsd*100` (admin-priced — change price in admin → new
   number, grep for a hardcoded 500 = FAIL), tier 3 + term in one tx, exactly one
   `debit_purchase`, keyed retry 0c, second tap 409 `already_active`.
   Reference raw output: `TASK_181_STEPS.md` snapshot harness block (PASS 21/21).

## 2. THE WRAPPER ITSELF (TASK_181 §6 acceptance — see prompt history in the steps file)

- **Menu B:** wrapper (`WRAPPER_MODE=devices`) nav = Devices + Settings only, **no Panic
  button**, branding "SpaceWorker OS" / dock "Devices"; direct GETs to other pages 404;
  zero public/private vocabulary in shipped chunks.
- **Free matrix:** tier 1 → create org after code → mint `.vbs` (+ PDF guide) works;
  device appears in Devices; **every action route 403 `xdevice_required`** (real curl with
  the free session) and the UI shows the Premium lock with Subscribe copy **without any
  duration string**.
- **Premium XDevice:** tier 3 → terminal/remote-control/tools unlock (`canUseDeviceTools`);
  expired tier 3 → 403 again. One org per user at ANY tier (premium unlocks actions, not a
  second org).
- **Methods:** wrapper dropdown = `.vbs` file, `EXE link`, `macOS (coming soon)` ONLY; web
  app zip + PowerShell unchanged.
- **Flag OFF regression:** full web app unchanged (nav, wording, all methods).

## 3. THE VBS CARRIER (P4b — CI artifact, run `37668649342`)

- Re-download the `spaceworker-devices-windows` artifact (`gh run download`): must contain
  `.exe` + `.vbs`; rejoined base64 === exe bytes; uppercase SHA-256 embedded;
  `Get-FileHash` verify with fail-closed `exit 1`/`Quit 1`; hidden PowerShell; no obfuscation.
- `npm run test:wrapper-carrier` (6/6) + `test:vantra-carrier` (21/21).
- **OPEN (owner):** step 35 — a REAL Windows double-click run of the 52 MB VBS (SmartScreen
  behaviour, install completes). If the owner has not run it, this is THE item to request.

## 4. REGRESSIONS + DEPLOY-STATE (playbook §7 then §2/§3)

- `npx tsc --noEmit` → 0; ESLint on touched files → 0 NEW (admin-panel carries **44
  pre-existing** errors — a stash A/B proved mine added none; don't "fix" the file).
- Suites: `test:xdevice` (38) · `test:vantra` (90) · `test:wallet` (63) ·
  `test:devices` (6) · `test:wrapper-carrier` (6) · `test:vantra-carrier` (21) ·
  `test:idlechip` (15) · workflow `check-workflow-syntax.mjs` → 0.
- Migration `20261117000000_task181_xdevice_price` (ADDITIVE `xdevicePriceUsd`) — confirm
  applied in `_prisma_migrations`, `rolled_back_at` NULL; flag ANY other new migration.
- Deploy-state: fresh `BUILD_ID` + mtime · service active · site 200 · `.map` greps
  `xdevice_required` · client chunk greps `Subscribe to Premium` and (for admin)
  `30d XDevice` · repo↔box md5 parity on touched files (the P5 deploy was a box build;
  parity was SAME/4-of-4 at ship time — re-check).
- `git log` commit separation (P0a money / P3 money / UI phases) + secrets grep clean.

## 5. HANDOFF + REPORT

- `SENIOR_HANDOFF.md` §6 state already carries the 2026-10-07 TASK_181 block — refresh it
  with your verified numbers. `TASK_181_DEVICE_WRAPPER_EXE.md` §8 is checked except the
  owner-acceptance row. `TASK_181_STEPS.md` is the tracker — check off/append what you prove.
- Rewrite THIS prompt for the next agent; `git commit -F` explicitly; push.
- Report: PASS/FAIL table over §1–§3, regression output, deploy-state evidence (BUILD_ID,
  probes), and an **openly unverified list** (Windows VM run, admin-panel browser click
  if you couldn't drive a browser) + the next queued item.
