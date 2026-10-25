# TASK_242 — an online device must never be reported offline in browser-clone setup

Branch: `agent/task-242-clone-setup-offline` off `705768b` (main after TASK_241).
Status: implemented + verified locally. **Not deployed.**

## What the user saw

Browser-clone "Device setup" card: **This PC · ready**, **Clone host · ready**,
relay `127.0.0.1:8118 · up · checked just now` — and a red
**"This device is currently offline."** on a machine the owner was actively using.

## Root cause (from live evidence, read-only)

- TRMM reported the agent **online** (`last_seen` 21 s old) at the same time the
  card said offline. One TRMM record, no duplicate agents.
- Audit trail: relay-probe **up** at 16:35:14; a setup `device_run_now` **failed**
  at 16:35:31 with `vantra_503: {"error":"This device is currently offline."}`;
  relay-probe **up** again at 16:40 / 16:45 / 16:50.
- So a single **transient TRMM command-channel blip** ("unable to contact the
  agent") hit an **online** device. TRMM's check-in (status) and its command
  websocket are different channels; a reconnect/burst can drop the latter briefly
  while the former keeps the device "online".

Three defects in OUR code turned that blip into the permanent lie on screen:

1. **No retry.** `runCommandNow` throws the 503 and setup aborts on the first try,
   even though an immediate retry succeeds on a device that is online.
2. **Wrong copy.** The blip is rendered as the absolute "This device is currently
   offline." — false for a machine that is up.
3. **Stale error never clears.** `setupErr` resets only when a NEW setup starts,
   so the red line outlived the condition and sat beside a green/ready card.

Not idleness, and not a genuinely offline device.

## Changes

1. **`lib/clone-setup.ts`**
   - `runNowWithTransientRetry(opts, device)` — on a `vantra_503` /
     `currently offline` / `unable to contact the agent` error, retry **once**
     after 1.5 s (setup commands are idempotent: downloads overwrite, staging is
     re-created). If it still fails while `deviceStatus(device) === "online"`,
     throw `agent_not_responding` instead of repeating the offline claim; if the
     device is genuinely offline, the real error is preserved.
   - Wired into the three calls that ABORT setup on throw: fetch, quarantine/stage,
     and hosted install.
   - `requireOnlineOwnedDevice` now returns `lastSeenAt` / `onlineConfirmedAt` so
     the retry seam can judge truth with the same `deviceStatus` model.
   - `isTransientAgentUnreachable` exported for the test.
2. **`lib/clone-setup-ui.ts`** (new, client-safe, pure)
   - `staleOfflineErrCleared(online, prev)` — drop an offline-flavoured headline
     when a fresh read proves the device online; keep every other error.
3. **`components/device-console.tsx`**
   - On each clone-setup poll, if `online === true`, clear a stale offline
     `setupErr` (functional `setSetupErr`, no stale closure).
   - `ERR_COPY.agent_not_responding`: "The agent didn’t answer that command just
     now — the PC is online, so try again in a moment." (never says offline).

## Tests

- `tests/clone-setup-ui.test.ts` — offline headline cleared when online; non-offline
  errors survive; offline headline stays when offline; predicate matches only
  offline claims.
- `tests/task-242-clone-setup-transient-offline.test.ts` — drives the REAL module's
  retry seam: transient offline retried once and succeeds; persistent failure on an
  ONLINE device → `agent_not_responding` (no "offline"); persistent failure on an
  OFFLINE device → real 503; unrelated error not retried; predicate scope.

## Verification (local, nothing sent to any live device)

- `tsc --noEmit` → 0.
- `eslint` (5 changed files) → 0 errors (one pre-existing unused-symbol warning in
  `lib/clone-setup.ts`).
- Focused: 9/9 pass.
- Full suite: **1807 tests / 1799 pass / 7 fail / 1 skipped**. Baseline
  `705768b`: 1798 / 1790 / 7 / 1. Delta: +9 tests, +9 pass, same 7 known
  failures (move-to-private ×5, TASK_179 ×2).

## Deploy (only on explicit go)

Merge → push → `workflow_dispatch` → verify BUILD_ID + services. Then on the live
console: the red offline line must disappear on the next poll while the device is
online, and a Re-run setup must not fail on a single blip. No migration.

## Notes

- Does not touch the forbidden `deviceStatus(source)` gate in `lib/clone.ts:1005`,
  `app/api/clones/**`, `components/clone-session-view.tsx`, or `openUrl`/`viewUrl`.
- The onboarding sweep is untouched (TASK_230 byte-exact pins preserved); the retry
  is confined to clone setup.
