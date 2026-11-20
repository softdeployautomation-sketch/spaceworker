# Task 46 — Pause + concurrency limits for the RAM-heavy mechanisms

**Status: ready for Cline.** Companion to Vantra's matching task (`TASK_43_QUEUE_ADMISSION_CONTROL.md` in that repo) — same concept, applied to each app's own heavy mechanisms. Once Vantra's Task 41 (Unified Ops Console) ships, both apps' Queue tabs are naturally visible together there (SpaceWorker's embedded via iframe, Vantra's native) — this task doesn't need to build any NEW cross-app plumbing itself, just get its own house in order the same way Vantra is.

## The ask, as given (2026-09-14)

> Also add to the admin for space worker, and vantra, each high mechanism that will take so much ram power, I want a button to turn on and off queue for that mechanism and in front a way to change how many can be in the queue at a time. And I need each platform arrange under a queue section so I can easily do what's needed to save ram and increase workload as needed while we plan to upgrade the server.

Context: this VPS runs SpaceWorker AND Vantra AND Vantra's own TRMM backend (Django/Celery/Daphne) AND MeshCentral, all on one box (confirmed via `lib/services-control.ts`'s comments in the Vantra repo) — genuinely resource-constrained until a planned server upgrade. The owner wants fast, direct dials to throttle the actual RAM-heavy work, not just the blunt systemd start/stop that `lib/services-control.ts` (Vantra) already provides.

## The two mechanisms in this app that actually spend real RAM

Confirmed by reading the code, not guessed:

1. **Search/extraction dispatch** (`app/api/internal/dispatch/route.ts`) — each "light"/"heavy" lane currently dispatches at most **1** concurrent job (hardcoded: `const running = await tx.searchJob.count({ where: { lane, status: "running" } }); if (running > 0) { ...lane_busy }`). Each running job is a real Python Playwright + Chromium process (the actual RAM cost).
2. **Browser Sessions** (`app/api/browser-sessions/route.ts`) — hardcoded `const MAX_CONCURRENT_SESSIONS = 3`. Each session is a full Neko browser-streaming container (the actual RAM cost).

Mail-queue-drain and the AI agent are NOT in scope — neither spends meaningful local RAM (SMTP sends and outbound API calls respectively, no local browser/container work).

## 1. Make both limits admin-adjustable, persisted (not hardcoded, not in-memory)

Extend `AdminSetting` (the same singleton-row pattern `webSubscriptionPriceUsd` etc. already use):
```prisma
model AdminSetting {
  ...
  dispatchLightEnabled          Boolean @default(true)
  dispatchLightMaxConcurrent    Int     @default(1)
  dispatchHeavyEnabled          Boolean @default(true)
  dispatchHeavyMaxConcurrent    Int     @default(1)
  browserSessionsEnabled        Boolean @default(true)
  browserSessionsMaxConcurrent  Int     @default(3)
}
```
Defaults exactly match today's hardcoded behavior — this is purely additive, zero behavior change until an admin actually touches a toggle or number.

## 2. Wire the toggle + limit into each mechanism

- **Dispatch** (`app/api/internal/dispatch/route.ts`): for each lane, read the matching `enabled`/`maxConcurrent` from `AdminSetting` at the top of that lane's dispatch attempt. If `enabled === false`, skip entirely (`results[lane_dispatch] = "queue_paused"`) — existing running jobs keep running to completion, only NEW claims stop. Replace the hardcoded `running > 0` check with `running >= maxConcurrent`, generalizing "1 per lane" into "admin-configured N per lane."
- **Browser Sessions** (`app/api/browser-sessions/route.ts`): read `browserSessionsEnabled`/`browserSessionsMaxConcurrent` instead of the hardcoded constant. When disabled, reject every new session start with a clear message ("Browser sessions are temporarily paused by an admin") regardless of current count — existing active sessions are untouched, only new ones are blocked.

## 3. A dedicated "Queue" admin tab

New tab (or promote the existing "Search Queue" tab into this role, folding Browser Sessions' limit in alongside it — Cline's call on whichever reads cleaner) showing, per mechanism: name, a toggle switch (mirrors `components/notifications-settings.tsx`'s `Toggle` component from Task 39 — reuse it, don't rebuild), a number input for max-concurrent with an immediate `PATCH` on change (same "Set" pattern as Task 40's per-user cap editor), and — genuinely useful given the RAM-management framing — a live count of how many are CURRENTLY running/active right now next to each limit, so the admin can see "2 of 3 browser sessions in use" while deciding whether to raise or lower it.

## Explicitly out of scope

- Any change to `lib/services-control.ts` (Vantra) or the coarser systemd start/stop controls it already provides — this is a narrower, faster-acting admission control layered on top, not a replacement.
- Auto-scaling or any automatic adjustment based on actual server RAM/load — this is manual dials only, for now.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean; migration applied.
- Live: set `dispatchLightMaxConcurrent` to 2, confirm two light-lane jobs can run simultaneously (previously impossible); set it back to 1, confirm behavior matches today exactly.
- Live: toggle `browserSessionsEnabled` off, confirm a new session start is rejected with the pause message while any already-active session keeps working; toggle back on, confirm new starts work again.
- Confirm the live running-count shown in the admin tab matches reality (cross-check against `SearchJob` rows with `status: "running"` / active `BrowserSession` rows directly in the DB, not just trusting the UI).
