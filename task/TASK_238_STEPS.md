# TASK_238 — device online truth (STEPS / handoff)

Branch: `agent/task-238-device-online-truth` (worktree `/Users/mikeolab/sw-t238`), base `0b0f213`.
Commit: `b975059` — code + tests. **Not deployed. Not pushed.**

## What was broken

Prod DB (2026-10-23): rows `status='online'` with `lastSeenAt` 2h/7h/8h stale.
`deviceStatus()` derived liveness from `lastSeenAt` only, so those online devices
read "offline" everywhere (badge, clone gate, manual capture). `29a4483` had
correctly stopped fabricating `lastSeenAt` for online agents whose Vantra payload
omits `lastSeen` — which exposed the missing anchor. `isUsable()` also OR'd the
raw status, so the host card could say "ready" while `requireOnlineOwnedDevice()`
refused with `device_offline`.

## What changed

- `prisma/schema.prisma:2044` — `Device.onlineConfirmedAt DateTime?`, with the
  reason written next to it. `lastSeenAt` is untouched (no invented heartbeats).
- `prisma/migrations/20261129000000_task238_device_online_confirmed_at/` —
  additive `ALTER TABLE "Device" ADD COLUMN "onlineConfirmedAt" TIMESTAMP(3);`
  (name sorts after `20261128000000_device_scripts`).
- `lib/devices.ts:32` — `VERDICT_FRESH_MS = 60_000`; `:38` `isVerdictFresh`;
  `:67` `deviceStatus({status, lastSeenAt, onlineConfirmedAt?})`:
  asleep first (heartbeat only) → offline authoritative → online when
  `isDeviceOnline(lastSeenAt) || isVerdictFresh(onlineConfirmedAt)`.
  `:94` `deviceListSelector` carries the column, so every list/console read gets it.
- `lib/vantra-link.ts:1566` — `onlineConfirmedAt = d.online ? now : null`, written
  on update **and** create (`:1575`, `:1585`). `lastSeenAt` line unchanged.
- Consumers unified on the selector:
  - `lib/clone-hosts.ts:70` `isUsable()` now `deviceStatus(device) === "online"`
    (raw-status OR removed); selects at `:122`, `:128` carry the column.
  - `lib/clone-setup.ts:672`, `:752` — selects carry the column (both callers
    already used `deviceStatus`).
  - `lib/device-screenshots.ts:1108` — manual `captureDeviceNow` uses
    `deviceStatus`. Scheduled `captureViaService` (`:334-343`) deliberately keeps
    the **raw verdict** with a comment: the background sweep is 1 min, there is
    no guaranteed sync inside the 60s verdict window, and its capture RPC fails
    closed anyway. (Task doc allows a raw read with a stated reason.)
  - `app/api/internal/device-status-sweep/route.ts:50` — select carries the column.
  - `components/device-console.tsx` needed no change: it maps
    `effectiveStatus ?? status` at `:732`, so `isOnline`/chips already use the
    derived value. `device-list.tsx` does the same at `:285-287`.
- WOL peer selection was left alone on purpose (out of scope; changing it pulls
  `deviceStatus` into the wake test harness). Follow-up candidate if a
  no-lastSeen device should be able to relay.

## Tests

- `tests/task-238-device-online-confirmed.test.ts` (new, 8) — selector matrix
  (stale/null heartbeat + fresh verdict → online; both stale → offline; offline
  authoritative; asleep not woken by a verdict; unknown; 60s boundary) + pins
  `DEVICE_ONLINE_WINDOW_MS === 5 min` (the rejected 10-min widening must not
  return) + selector has the column.
- `tests/task-238-clone-host-truth.test.ts` (new, 5) — loads the REAL
  `clone-hosts` with a fake db: production shape is usable, both-stale is
  offline with the host named, hosted destination judged the same, and a matrix
  asserting `hostAvailability().available === (deviceStatus(row) === "online")`.
- `tests/vantra-link-installer.test.ts` — 3 sync tests (online/no-lastSeen stamps
  the verdict only; offline clears it and keeps the old check-in; re-sync
  refreshes the verdict without restamping `lastSeenAt`). Rewrote the stale
  "online + no lastSeen IS stamped now" test, which was already failing on the
  base (one of the authorised failures).
- `tests/device-status.test.ts` — updated the two stale 10-minute-window
  assertions to the 5-minute reality (also already failing on the base).

## Verification (local, this worktree)

- `prisma validate` + `generate` — clean (local prisma 6.19.3; `DATABASE_URL`
  placeholder only).
- `tsc --noEmit` — exit 0.
- eslint on all changed files — 0 errors (1 pre-existing warning:
  `hostedAvailableForUser` unused in `lib/clone-setup.ts:730`).
- Targeted: TASK_238 selector 8/8, clone-host 5/5, vantra-link 108/110 (2
  pre-existing mesh-flag failures), device-status 6/6.
- Full `tests/*.test.ts` with CI-style env: **1772 tests / 1764 pass / 7 fail /
  1 skipped**. The 7 are the pre-existing move-to-private (5) and TASK_179
  carrier (2) failures — no new failures vs the authorised baseline.

Note: this worktree has no `node_modules`; it is symlinked to
`/Users/mikeolab/spaceworker/node_modules` and `prisma generate` refreshed the
shared client (additive column only).

## Deploy (senior lane only)

1. Push the branch; merge to `main` only through the normal gate.
2. The migration MUST be applied with the deploy — the build/typecheck is
   unaffected, but any query selecting `onlineConfirmedAt` fails without it.
3. Deploy is `workflow_dispatch` only:
   `gh workflow run "Build & Deploy" -R softdeployautomation-sketch/spaceworker --ref main`.
4. Verify `/opt/spaceworker/.next/BUILD_ID` mtime; then confirm the prod DB has
   the column and that an online/no-lastSeen row now reads `effectiveStatus:
   "online"` via `/api/devices` as that owner.

## Known caveat to watch live

`VERDICT_FRESH_MS` is 60s, chosen against 20s interactive syncs. The background
onboarding sweep is 1 min (`deploy/device-onboarding-sweep.timer`), so a
no-lastSeen online device can sit at the 60s boundary for a few seconds per
minute (timer jitter) on non-interactive surfaces. Interactive list/console
refresh every 20s and are unaffected. If live badges flap, widen the verdict
window (e.g. 3 min) — do **not** widen `DEVICE_ONLINE_WINDOW_MS`.
