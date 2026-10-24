# TASK_239 — private browser US/CA exit routes (STEPS / handoff)

Branch: `agent/task-239-private-browser-exit-routes` (worktree `/Users/mikeolab/sw-t239`), base `0b0f213`.
Commit: `4b2bab9` — code + tests. **Not deployed. Not pushed.**
Task doc: `TASK_239_PRIVATE_BROWSER_EXIT_ROUTES.md` (in `/Users/mikeolab/sw-vbsfix`).

## Code half — DONE

Root cause (measured 2026-10-23): `BrowserSession.exitIpSnapshot` was empty for 5
of the last 10 US/CA sessions because `checkIpThroughProxy()` timed out and the
launch route swallowed it (`.catch(() => null)`). Separately, a host-side curl
proved the proxy, not the container's own route to it. The nodes were also open
to the internet (Part 1).

### 1. Honest, typed failure

- `prisma/schema.prisma:1428-1434` — `BrowserSession.exitIpError String?`,
  `exitIpCheckedAt DateTime?`, `exitIpPath String?` (all additive nullable).
- Migration `prisma/migrations/20261130000000_task239_browser_session_exit_ip_audit/`
  (sorts after TASK_238's `20261129000000_…`).
- `lib/browser-proxy.ts:121` — pure `classifyIpCheck()` with the taxonomy
  `timeout | unreachable | bad_response | empty`; `:162` `probeIpThroughProxy`,
  `:171` `probeDirectIp`, both taking an injectable `CurlRunner` so tests open
  no socket. The throwing `checkIpThroughProxy` / `checkDirectIp` remain as thin
  wrappers for the hosted-clone relay proof and the BYO test.
- `lib/browser-session-exit-ip.ts` — `buildExitIpAudit(result, {proxyReachable})`
  produces `{exitIpSnapshot, exitIpError, exitIpCheckedAt, exitIpPath}`.
- Launch route `app/api/browser-sessions/route.ts:251` uses it; a failed check
  no longer yields `null` silence and still returns 201.
- IP route `app/api/browser-sessions/[id]/ip/route.ts` returns the typed code
  (502 `{ok:false,error:"timeout"}`) instead of a swallowed sentence.
- Safe select + serializer carry all four fields; the session panel renders
  `IP check failed: <code>` from the persisted row when no live result exists;
  the admin table shows `failed: <code>` instead of `—`.

### 2. Label the measured path

- `browser-server/server.ts:505` `probeContainerProxy()` runs
  `docker exec <container> /bin/sh -c 'timeout 3 bash -c "</dev/tcp/HOST/PORT>"'`
  after the container is up, and stores the verdict in the session registry.
  Host/port are restricted to hostname/IP characters + numeric port because a
  BYO host is user-supplied and the string runs in the container's shell.
- `start` and `restart` responses now include `proxyReachable`
  (`null` = direct, `false` = container could not reach the proxy).
- `exitIpPath` is `"container"` **only** when that probe passed, else `"host"`.
  A host-success + container-failure is persisted as
  `exitIpError: "container_unreachable"` (the IP snapshot is still kept as
  evidence of the proxy's egress, not as a claim about the container's path).

### 3. Node health

- `lib/exit-node-health.ts` — cached (30s TTL, `EXIT_NODE_HEALTH_TTL_MS`) probe
  per configured node over its own SOCKS route, injectable prober, in-flight
  de-dupe, and cache invalidation when an endpoint changes.
- `app/api/admin/exit-node-health/route.ts` — admin-only, no-store
  `GET /api/admin/exit-node-health`.
- `lib/env-health.ts` keeps its boot-time "configured?" check and now points at
  the live health module (boot stays offline).

### 4. Switch route

- `app/api/browser-sessions/[id]/switch/route.ts:93` — after a successful
  restart, probe the NEW node and persist `exitNodeId` + the same audit.
  A failed restart still returns 502 and leaves the row untouched; a failed
  post-restart check keeps the switch (the restart succeeded) and records the
  typed reason.

### Not changed (deliberately)

- No SOCKS auth in app code — socat has none; that is Part 1.
- Hosted-clone `openUrl`/`viewUrl`, clone lifecycle routes, `lib/clone.ts` and
  `components/clone-session-view.tsx` are untouched.

## Tests — `tests/task-239-exit-route-truth.test.ts` (7/7)

- taxonomy: timeout (flag + curl 28), unreachable (7/56), empty body, non-JSON,
  JSON without an address, success;
- `probeIpThroughProxy` sends `--proxy socks5://…`; `probeDirectIp` sends none;
- audit matrix: container-proven vs host-only vs container failure;
- health cache: one probe per node, no re-probe inside 30s, re-probe after TTL,
  `force`, endpoint-change invalidation;
- safe-select + serializer include the four fields.
No sockets: every probe is injected. Route-level 201/502 behaviour is exercised
through the pure audit helper; the routes are thin wrappers around it.

## Gates (local, this worktree)

- `prisma validate` + `generate` — clean (placeholder `DATABASE_URL`).
- `tsc --noEmit` — exit 0.
- eslint on changed files — 0 new errors. `components/browser-session-panel.tsx`
  has 3 PRE-EXISTING `react-hooks/set-state-in-effect` errors (same 3 on main),
  and `browser-server/server.ts` has 2 pre-existing unused-disable warnings.
- Full `tests/*.test.ts` with CI-style env: **1764 tests / 1753 pass / 10 fail /
  1 skipped**. The 10 are this base's known pre-existing failures (stale
  device-status 10-min tests, move-to-private ×5, stale TASK_230 online-stamp,
  TASK_179 ×2). TASK_238's fixes (separate branch) remove four of them on merge.
- Worktree has no `node_modules`; it is symlinked to
  `/Users/mikeolab/spaceworker/node_modules` (prisma client regenerated,
  additive columns only).

## BLOCKING deploy-lane prerequisite — Part 1 (do NOT skip)

Until Part 1 lands, the app-side check will keep timing out: the nodes are
open proxies being consumed by strangers (117 socat procs / 81 conns from
`204.76.203.0/24`, `103.47.145.247`, `107.167.83.74` at 16:26).

1. On the VPS, edit both units:
   - `fly-relay-us.service`: `TCP4-LISTEN:1090,bind=172.17.0.1,fork,reuseaddr …`
   - `fly-relay-ca.service`: `TCP4-LISTEN:1091,bind=172.17.0.1,fork,reuseaddr …`
   `systemctl daemon-reload && systemctl restart fly-relay-us fly-relay-ca`.
2. Firewall: allow `172.17.0.0/16` + `lo`, deny the public side for 1090/1091
   (UFW or iptables). UFW is currently inactive and `iptables -P INPUT ACCEPT`.
3. Verify:
   - `ss -ltnp | grep -E ':109[01]'` shows `172.17.0.1`, not `0.0.0.0`;
   - from a Mac: `curl --socks5-hostname 164.68.105.96:1090 https://api.ipify.org`
     **fails**; same for `:1091`;
   - from a neko container: the equivalent probe **succeeds**;
   - idle socat child count stays flat (no new strangers).
4. Optional: `-T 60` idle timeout + a connection cap.
5. Rollback: revert the unit lines/rule, reload, restart. No app deploy needed.

## Deploy order

1. Merge the branch through the normal gate (after TASK_238 if both are queued —
   the migrations are ordered `20261129…` then `20261130…`).
2. Apply the migration with the deploy (queries select the new columns).
3. `workflow_dispatch` only:
   `gh workflow run "Build & Deploy" -R softdeployautomation-sketch/spaceworker --ref main`.
4. Verify `/opt/spaceworker/.next/BUILD_ID` mtime; then, as the owner, start a
   US session: either a non-VPS IP is recorded or the panel shows a typed
   `IP check failed: <code>`, and `GET /api/admin/exit-node-health` answers
   per-node ok/ip/error.
5. Part 1 must be live before calling the owner report fixed.
