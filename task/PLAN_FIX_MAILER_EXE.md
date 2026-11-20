# Plan: Fix Mailer EXE — campaigns + mailboxes + license working again

## Owner report
The published mailer EXE shows "Failed to load campaigns" and Settings → License
shows an internal error. Campaigns and mailboxes "worked perfectly before" the
server switch; the previous fix pass started from `main` and scattered the
standalone work.

## Root cause (corrected)
The working mailer standalone was built on the **`mailer-exe` branch** (TASK_201
S7, 2026-10-10): embedded PGlite Postgres, synthetic local session, local drain
loop, mailer variant env. That branch was **never merged to `main`**. The Nov 8
mailer rebuild (`be79781`) was cut from `main`, whose bundled runtime has:

- no local database (`prisma`/`db` fall through to an empty `DATABASE_URL`),
- no synthetic session (`getSession()` returns null → `/api/campaigns` 401),
- `lib/env.ts` still throwing on `APP_BASE_URL`/`DATABASE_URL` at import.

So campaigns/mailboxes/templates failed inside the EXE even though the hosted web
app was fine. This is a regression from branch divergence, not a new bug.

## Fix applied
1. Merged `origin/mailer-exe` into `main` (`9814969`).
   - Adds `lib/local-exe-db.ts` (PGlite through the Prisma driver adapter),
     `lib/auth.ts` synthetic `getSession()` for the local mailer runtime,
     `lib/prisma.ts`/`lib/db.ts` local routing, `instrumentation.ts` boot seed,
     `lib/local-exe-drain.ts` + `/api/exe/drain-settings`, mailer-sources
     pipeline, localized license/trial, and the mailer variant env
     (`SESSION_SECRET`, `INTERNAL_BEARER_TOKEN`, `MAILBOX_ENCRYPTION_KEY`,
     `APP_BASE_URL=http://127.0.0.1:34413`) written by `runtime-assemble.mjs`.
   - `lib/env.ts` degrades hosted-only vars ONLY when
     `SPACEWORKER_LOCAL_EXE=true`; every other deployment keeps the loud
     fail-closed boot.
   - Generated local schema `db/schema.sql` from the same `prisma/schema.prisma`
     the web app uses (no drift).
2. Kept the Nov 8 fixes that live only on `main`:
   - `HOSTED_APP_URL` default `https://spaceworker.top` (TASK_253 dead-IP guard).
   - mailer nav (Overview, Campaigns, Settings) + startup `/dashboard`.
   - `tauri.mailer.conf.json` build/frontendDist/resources.
3. Merged the tier-3 campaign entitlement gate (`02b574b`): GET/POST/DELETE
   campaign routes return 403 `not_entitled` for tier 3; campaign pages render
   the mailer lock card. Tier 5 keeps `mailer`; the local EXE user is tier 5.

## Verification (local assembled mailer runtime, darwin x64)
- `npx tsc --noEmit` → **0**.
- `npm test` → **1924 pass / 17 fail / 1 skipped**; the 17 are the known
  pre-existing device/Vantra failures (TASK_253 baseline, unrelated files).
- `CI=true BUILD_TARGET=mailer npx next build` → **0**.
- `BUILD_TARGET=mailer node scripts/runtime-assemble.mjs` → **0**; wrote
  `db/schema.sql` (92,759 bytes) + mailer `.env.local`.
- Booted `exe/runtime/standalone` on port 34999:
  - `GET /api/campaigns` → **200 `[]`**
  - `GET /api/mailboxes` → **200 `[]`**
  - `GET /api/automations/templates` → **200 `[]`**
  - `GET /api/entitlements` → **200**, `premium:true`, `mailer` granted
  - `GET /dashboard`, `/dashboard/campaigns`, `/dashboard/settings` → **200**
  - `POST /api/mailboxes` (smtp.gmail.com:587) → **200**, persisted
  - `POST /api/campaigns` (1 recipient + that mailbox) → **201**, 1 queued item,
    then `GET /api/campaigns` returns it → local persistence proven
  - `POST /api/exe-license/status` → **200** with machine id / trial state
  - boot log: `[local-exe] database ready; auto-drain loop started`

## Shipped (2026-11-09)
- [x] Pushed `main` (`20eacc1`).
- [x] Build EXE variant=mailer run `42561608865` → success; installer
      `139,751,277` bytes, sha256 `07e7877e8efe91b5389308c7542dae8621efed96fb66e79a4dcc57cd5f4ed275`.
- [x] Build & Deploy run `42564581752` (workflow_dispatch) → success at
      `20eacc1`; box `BUILD_ID=gCvtdYrI13TtbqwDVpQt6`; the tier-3 gate string
      is present in `.next/server/chunks`; `tests/xdevice-tier.test.ts` 19/19.
- [x] Installer hosted on the VPS (see "Download" below).
- [ ] Owner: install and test campaign create/send, mailbox add, License panel.

## Download
- https://dl.instaweb.top/SpaceWorker-Mailer-Setup-0.1.0.exe
- https://spaceworker.top/downloads/SpaceWorker-Mailer-Setup-0.1.0.exe
- `Content-Length: 139751277`; sha256 verified on the box and over HTTPS.
- Box path: `/opt/spaceworker/public/downloads/SpaceWorker-Mailer-Setup-0.1.0.exe`
  (`trmm:trmm`, `0644`), served by nginx `location /downloads/`.

## Why the EXE is not committed
The merged runtime is ~133 MB (PGlite/Postgres WASM + Prisma adapter + Node),
over GitHub's 100 MB per-file push limit. `public/downloads/*.exe` is therefore
gitignored and `.gitkeep` keeps the dir; the binary is a box-side artifact.
Future `Build & Deploy` runs no longer include it, so they cannot overwrite the
VPS copy. To refresh: run **Build EXE** (variant=mailer), then scp the installer
to the box path above. Git LFS is the follow-up if we want it repo-shipped.

## Notes
- Working tree still has unrelated local edits (Vantra/cyberlab/TASK_249); they
  are not part of these commits and are not shipped.
- `exe/runtime/` and `.next/` are build artifacts (not committed).
