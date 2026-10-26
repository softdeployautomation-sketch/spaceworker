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

## Architecture note (asked during review)

The clone's **IP route does not depend on TRMM**. The source relay holds a
persistent dial-out tunnel to `browser-server` (`GET /relay/control-status` →
`{"up":true}` for the device); at launch the hosted Chromium's `--proxy-server`
points at browser-server's per-session listener (docker bridge gateway), which
forwards over that tunnel (`lib/clone-hosted-launch.ts:257`). Hosted/private
launches never take the TRMM agent-RPC path (`lib/clone.ts:1316`). TRMM is only
used for the **one-time setup** (install/start the relay, run setup commands) and
health probes — and that setup command channel is the piece that blips.

## Changes

1. **`lib/clone-setup.ts`**
   - `runNowWithTransientRetry(opts)` — on a `vantra_503` / `currently offline` /
     `unable to contact the agent` error, retry with 1 s then 2 s backoff (3
     attempts total; setup commands are idempotent: downloads overwrite, staging is
     re-created). If the channel is still down it **rethrows the original error** —
     there is deliberately **no** "agent didn't answer" / `agent_not_responding`
     copy.
   - Wired into the three calls that ABORT setup on throw: fetch, quarantine/stage,
     and hosted install. Each wraps the call; a transient error that outlived the
     retries pushes a neutral failed step (`did not complete — run setup again`)
     and ends setup via `bail()` **without a red headline**; any non-transient
     error still propagates.
   - `isTransientAgentUnreachable` exported for the test.
2. **`lib/clone-setup-ui.ts`** (new, client-safe, pure)
   - `staleOfflineErrCleared(online, prev)` — drop an offline-flavoured headline
     when a fresh read proves the device online; keep every other error.
3. **`components/device-console.tsx`**
   - On each clone-setup poll, if `online === true`, clear a stale offline
     `setupErr` (functional `setSetupErr`, no stale closure).

## Tests

- `tests/clone-setup-ui.test.ts` — offline headline cleared when online; non-offline
  errors survive; offline headline stays when offline; predicate matches only
  offline claims.
- `tests/task-242-clone-setup-transient-offline.test.ts` — drives the REAL module's
  retry seam: transient offline retried and succeeds (2 calls); persistent channel
  failure retries 3 times then rethrows the real `vantra_503` (asserts **no**
  `agent_not_responding`); unrelated error not retried; predicate scope.

## Verification (local, nothing sent to any live device)

- `tsc --noEmit` → 0.
- `eslint` (5 changed files) → 0 errors (one pre-existing unused-symbol warning in
  `lib/clone-setup.ts`).
- Focused: 8/8 pass.
- Full suite: **1806 tests / 1798 pass / 7 fail / 1 skipped**. Baseline
  `705768b`: 1798 / 1790 / 7 / 1. Same 7 known failures (move-to-private ×5,
  TASK_179 ×2).
- Live relay tunnel for the device confirmed `{"up":true}` (constant egress,
  independent of TRMM).

## Deploy (only on explicit go)

Merge → push → `workflow_dispatch` → verify BUILD_ID + services. Then on the live
console: the red offline line must disappear on the next poll while the device is
online, and a Re-run setup must not fail on a single blip. No migration.

## Notes

- Does not touch the forbidden `deviceStatus(source)` gate in `lib/clone.ts:1005`,
  `app/api/clones/**`, `components/clone-session-view.tsx`, or `openUrl`/`viewUrl`.
- The onboarding sweep is untouched (TASK_230 byte-exact pins preserved); the retry
  is confined to clone setup.
