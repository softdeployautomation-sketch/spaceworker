# Task 112 (bit B6) — Clone expiry, staging teardown + 30-day purge

**Status: NOT STARTED.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B6**). Depends on **B3** (`TASK_109`).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §CROSS-TRACK RULE 7; owner decisions (records kept · staging deleted at terminal · 30-day inactive purge).

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-112-clone-sweep`, push.
> **Do not** deploy, ssh the VPS, touch `.env`, or enable the timer — the owner
> installs and enables it. Full rules:
> `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`HOW_WE_MOVE_FAST.md`** §0–§3 (**§2 deploy**) and **§6**.
- **The existing sweep to mirror exactly:**
  `app/api/internal/digest-sweep/route.ts` (internal-bearer route) +
  `deploy/digest-sweep.service` + `deploy/digest-sweep.timer` (systemd wiring +
  `lib/internal-auth.ts::requireInternalBearer`).
- **`TASK_109_CLONE_ORCHESTRATOR.md`** — `expireClones()` and `refreshRelayHealth()`
  are already implemented there; **this task schedules and completes them**, it does
  not re-implement the TTL logic.
- **`TASK_107_CLONE_SCHEMA_AND_ADMIN_CAPS.md`** — `clonePurgeAfterDays` (30),
  `cloneIdleTtlMinutes` (60), `cloneHardTtlMinutes` (480) all come from AdminSettings;
  read them through `lib/clone-settings.ts`. **Never hardcode these numbers.**

## Deliverables

1. `app/api/internal/clone-sweep/route.ts` — `requireInternalBearer`, then in order:
   - **TTL enforcement** → `expireClones()` (idle TTL + hard cap; revokes the session
     and writes the terminal audit row).
   - **Relay health** → `refreshRelayHealth()` over the devices that have a relay
     row (bounded batch; do not probe every device every run).
   - **Staging teardown** → delete the encrypted capture for every **terminal** job
     that still has a `stagingRef`; a missing file is success, not an error
     (idempotent). Clear the reference so the next run is a no-op.
   - **Record purge** → delete clone records that are **terminal AND older than
     `clonePurgeAfterDays`** (inactive). An active/pending job is **never** purged,
     no matter its age.
   - Respond with **counts only** — `{ expired, relaysChecked, stagingDeleted, purged }`.
2. **Single-flight** — overlapping timer runs must not double-execute. Use a simple
   guard (a dated AdminSetting lock row or an advisory lock); if one is already
   running, return `{ skipped: true }` with **200**.
3. `deploy/clone-sweep.service` + `deploy/clone-sweep.timer` — mirror the
   digest-sweep pair, firing **every 5 minutes** (TTL and relay health are
   time-sensitive; a daily sweep would leave dead sessions and stale relay state).
   Include the same `Environment=`/`ExecStart` conventions as digest-sweep.

## Logging (must not leak)

Log **counts and clone ids only**. Never log staging paths, cookie counts per profile,
session URLs, tokens, or anything from inside a capture.

## Out of scope

- The governor (`TASK_105`), the state machine (`TASK_109`), API routes (`TASK_110`),
  UI (`TASK_111`).
- Enabling/installing the timer on the server (owner).

## Acceptance (owner runs after deploy)

- `tsc --noEmit` clean.
- Route: unauthenticated → **401**; authenticated with the internal bearer → **200**
  and a JSON counts object.
- Two consecutive runs → the second is a clean no-op (idempotent).
- A clone left past its idle TTL → session revoked, terminal audit row present.
- A terminal job with a staging file → file gone after one run; a missing file →
  still `200`, no error.
- A 31-day-old **terminal** record → purged; a 31-day-old **active** record → untouched.
- Stop the relay and run the sweep → `RelayHealth.status` flips and
  `consecutiveFailures` increments; restart it → recovers.
- `journalctl -u clone-sweep` shows counts only — no paths, URLs or secrets.
- Timer is `enabled` + `active` after the owner installs it, and the service exits 0.

## Report back

Files added · `tsc` result · the guard mechanism chosen for single-flight · the
schedule you configured · anything unverified.
