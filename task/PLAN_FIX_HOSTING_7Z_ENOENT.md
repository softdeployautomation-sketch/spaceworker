# Plan — fix "spawn 7z ENOENT" on site upload (hosting)

## Status: COMPLETE (production issue resolved); code fix ready to ship

## Diagnosis (done)
- `lib/hosting/extract.ts` shells out to `7z` via `spawn("7z", args, ...)` (used by `listArchive`/`extractArchive`, the site-upload pipeline in `lib/hosting/sites.ts`).
- Locally on macOS `7z` exists at `/usr/local/bin/7z` → no repro locally.
- On production VPS (`207.244.224.57`, Ubuntu 22.04, service user `trmm`): **`7z` was NOT installed** (absent from PATH and `/usr/local/bin`, `/usr/bin`, `/bin`). → `spawn 7z ENOENT` on every site zip upload.
- The admin "choose which site" change (TASK_225/TASK_157 domain work) led to the upload that exposed it.

## Fix (code) — `lib/hosting/extract.ts` (committed locally, not yet deployed)
- Added `resolveSevenZip()`: resolves `7z` from `SEVEN_ZIP` env override → `/usr/local/bin/7z` → `/usr/bin/7z` → `/bin/7z`, falling back to bare `"7z"` (PATH). Cached per process.
- `run7z` spawns the resolved binary; if an absolute path is not executable it rejects with a clear, actionable message instead of a cryptic ENOENT.
- Verified: `tsc --noEmit` exit 0, `eslint lib/hosting/extract.ts` clean, `resolveSevenZip()` returns `/usr/local/bin/7z` locally.

## Fix (box) — DONE, restores uploads now (no service restart)
- Installed `p7zip-full` on the VPS → `7z` at `/usr/bin/7z`, which IS in `trmm`'s PATH.
- Verified as `trmm`: `command -v 7z` → `/usr/bin/7z`, `7z-OK`.
- The currently deployed `spawn("7z")` now resolves 7z via PATH → site uploads work immediately.

## Remaining (needs owner GO per 🚦 rule)
- The code fix lives on `main` (uncommitted until you say so). To make it durable on the box it must be pushed + `gh workflow run 'Build & Deploy'`, which restarts `spaceworker` — per the playbook I will not do that without your explicit GO. Say the word and I'll commit/push/dispatch.
- Until then, production is already fixed by the `p7zip-full` install.
