# Task 238 — Browser Clone Offline and Exit Routes

**Status**: IN PROGRESS — implementing fixes for two reported bugs

## 1. Summary

This task addresses two bugs in the browser clone feature:

1. **Bug 1**: Browser clone incorrectly shows "device offline" during relay setup when the device is actually online and active
2. **Bug 2**: Private browser route not working despite fixing the fly.io part

## 2. Bug 1: Device Offline False Positive During Relay Setup

### Problem
When initiating a browser clone with relay egress mode, the system incorrectly reports the source device as "offline" during relay setup, even when the device is online and active. This is caused by the relay health probe checking device online status using a 5-minute `lastSeenAt` window that can be too aggressive, combined with the relay probe potentially failing when the device's Vantra agent heartbeat is slightly stale.

### Root Cause
In `lib/clone.ts`, the `requestClone` function probes relay health before capture (lines 1014-1036). The probe uses `probeCloneRelay` which requires the source device to have a valid `vantraAgentId`. If the device's `lastSeenAt` timestamp is slightly older than 5 minutes, `isDeviceOnline()` returns `false`, causing the device to be marked as "offline" even if the relay is actually reachable.

Additionally, the relay health check in `clone-transport.ts` (`probeCloneRelay`) requires the device to have a valid Vantra agent ID, and if the agent's heartbeats are momentarily interrupted, the probe can fail incorrectly.

### Fix
1. **Relax the online check during relay probe**: Modify the relay health probe to not fail solely based on the 5-minute online window. Instead, use a longer grace period or skip the online status check during the relay probe phase, since the relay probe itself tests connectivity.

2. **Add relay reachability independent of device online status**: The relay health check should test actual relay connectivity, not device online status. Update the logic to separate these concerns.

3. **Increase tolerance for stale heartbeats**: During clone initiation, allow a longer window before declaring the device offline, since the relay probe is the actual test of connectivity.

### Files to Modify
- `lib/clone.ts` - Modify the relay health check logic (lines ~1014-1036)
- `lib/devices.ts` - Consider adjusting `DEVICE_ONLINE_WINDOW_MS` or adding a separate "clone-initiation" online check

## 3. Bug 2: Private Browser Route Not Working

### Problem
The private browser route (for opening cloned browser sessions) is not working despite fixing the fly.io part. This suggests there's a routing or configuration issue specific to the browser clone session routes.

### Root Cause
Investigation reveals that the `CloneSessionView` component and the `/clone/[cloneId]/page.tsx` route have a session gate issue (TASK_216 D1). The page exports `force-dynamic` but Next.js 16 bakes redirects into prerender artifacts at build time when there's no cookie, causing the page to 307 redirect everyone forever.

Additionally, the route at `app/api/clones/[cloneId]/session/route.ts` requires proper session handling and the `openUrl` field to be properly stamped at launch time.

### Fix
1. **Ensure `force-dynamic` is properly set**: Verify all server-side clone routes export `dynamic = "force-dynamic"` to prevent Next.js from baking redirects.

2. **Fix session gate in CloneSessionView**: The `CloneSessionView` component needs to properly handle the session check and not rely on prerendered artifacts.

3. **Ensure openUrl is properly stamped**: The `/api/clones/[cloneId]/session` route must return a valid `openUrl` that was stamped during the launch step.

4. **Fix any missing route handlers**: Check for any missing or incorrectly configured API routes related to browser clone sessions.

### Files to Modify
- `app/clone/[cloneId]/page.tsx` - Ensure `force-dynamic` is properly set
- `app/api/clones/[cloneId]/session/route.ts` - Verify session handling and `openUrl` generation
- `components/clone-session-view.tsx` - Fix any session handling issues

## 4. Exit Routes Definition

This task also defines proper exit routes for browser clones:

### Clone Exit States and Routes

| Exit State | Trigger | Exit Route | Auditing |
|---|---|---|---|
| `expired_idle` | No activity for 60 min | Automatic teardown + audit `expired_idle` | `recordAgentActionAudit` action "browser-clone" |
| `expired_hard` | After 8 hours hard cap | Automatic teardown + audit `expired_hard` | `recordAgentActionAudit` action "browser-clone" |
| `revoked` | User or admin revocation | `POST /api/clones/[cloneId]/revoke` | `recordAgentActionAudit` action "browser-clone" |
| `failed` | Relay failure, capture failure, etc. | State transition to `failed` | `recordAgentActionAudit` action "browser-clone" |
| `deleted` | Admin deletion | `DELETE /api/clones/[cloneId]` | `recordAgentActionAudit` action "browser-clone" |

### Exit Route Implementation

Each exit route must:
1. Transition the clone to the terminal state
2. Audit the exit event with `recordAgentActionAudit`
3. Clean up resources (staging material, browser processes)
4. Update related records (RelayHealth, DeviceJob, etc.)
5. Return appropriate HTTP response

### Files to Create/Modify
- `lib/clone.ts` - Ensure all transition paths properly audit and clean up
- `lib/clone-state-sync.ts` - Ensure state sync handles exit routes
- `lib/clone-sweep.ts` - Ensure sweep properly handles all exit states