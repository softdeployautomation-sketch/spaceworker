# Task 106 (bit C1) — Device idle time + live refresh of the device list

**Status: NOT STARTED.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **C1**).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §VANTRA PARITY (V1/V2), §CROSS-TRACK RULES 2/7.

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-106-idle-refresh`, push the
> branch. **Do not** deploy, **do not** ssh the VPS, **do not** touch `.env`, **do not**
> run `prisma migrate deploy`. The owner verifies + deploys.
> Full rules: `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`HOW_WE_MOVE_FAST.md`** §0–§3 (deploy discipline) and **§6** (gotchas: the
  rsync `--files-from` + `-r` trap, "never write JSX through a shell heredoc").
- **`TASK_95_DEVICES_V2_TOOLS_PARITY.md`** — the layer this extends
  (`components/device-list.tsx`, `components/device-console.tsx`, `lib/device-tools.ts`).
- **`TASK_92_ASSISTANT_FOUNDATION_AND_ENTITLEMENTS.md`** — the shared device layer
  (`lib/devices.ts`, `deviceListSelector`, `toDeviceView`, `deviceStatus`).
- **Vantra:** `lib/meshcentral-api.ts`, `lib/sw-agent-tenant.ts`,
  `app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts` (the exact pattern to copy).

## The owner's report (verbatim intent)

1. *"We don't get idle and idle-active time — we need an idle time too. We can track
   that with the device mouse and keyboard to know when last it was idle, not just
   checking active status."*
2. *"The SpaceWorker device tabs don't load current activity — I have to click
   Refresh to see a user come online. It should auto-refresh."*

## Findings already made (do NOT re-investigate)

- **MeshCentral already reports idle time.** Vantra's `lib/meshcentral-api.ts`
  opens `control.ashx`, sends `{"action":"nodes"}` and the response's per-node
  objects carry `idletime` (and `conn`, `users`, `osdesc`, `ip`). See the doc
  comment block above `findMeshNodeIdByHostname()` (~line 225 of that file).
  **Reuse that function's websocket/auth flow — do not write a second client.**
- `findMeshNodeIdByHostname(hostname, expectedIp)` already exists and **fails
  closed** when the hostname is ambiguous — keep that behaviour; the idle lookup
  must apply the *same* hostname + expectedIp matching (never guess a device).
- The **SpaceWorker console already polls every 15 s** (`components/device-console.tsx`,
  `setInterval` inside the poll `useEffect`). Only the **list page** is stale-on-load
  (`components/device-list.tsx` loads once; there is a manual Refresh button).
- `/api/devices` returns rows via `toDeviceView()` and is the **single** source the
  list and the console both read — enrich it once and both surfaces benefit.

## ⚠️ Verify before wiring the UI copy (units)

MeshCentral's `idletime` unit must be confirmed on the live box (seconds vs
minutes). **Do not hardcode an assumption into copy.** Implement:

- one exported constant `MESHCENTRAL_IDLETIME_UNIT: "seconds" | "minutes"`
  (default `"seconds"`, documented), and
- one `formatIdle(raw): string` helper that renders `"active now"`, `"idle 12 min"`,
  `"idle 3 hr"`, `"unknown"`.

The owner confirms the unit at deploy; if it is minutes it is a **one-line** change.

## Deliverables

### A — Idle lookup (Vantra side)

1. `vantra/lib/meshcentral-api.ts`
   - Export `listMeshNodes()` returning the flat node array
     (`{ _id, name, ip?, idletime?, conn?, users? }`) from **one** `{"action":"nodes"}`
     round trip.
   - Refactor `findMeshNodeIdByHostname()` to consume `listMeshNodes()` — **behaviour
     must stay identical** (single-match, or IP-agreement, else `null`).
2. `vantra/app/api/internal/sw/devices/[agentId]/idle/route.ts` (new)
   - Copy the shape of the sibling `mesh-urls/route.ts`: `verifySwSecret` → `401`;
     `assertAgentInSwOrg(agentId)` → `404` when not in a `sw-` org; then resolve the
     agent's `hostname` + `public_ip` (the same `lib/trmm.ts` lookup `mesh-urls` uses)
     and match via `listMeshNodes()`.
   - Respond `{ ok: true, idleSeconds, idleUnit, online }`.
   - Fail-soft: mesh lookup unavailable → **200** with `idleSeconds: null`
     (idle is decoration, never a blocker).

### B — Bulk enrichment (SpaceWorker side)

3. Add `fetchOrgIdle(orgId)` using the **existing** `vantraFetch` helper in
   `spaceworker/lib/vantra-link.ts` — **ONE** org-scoped call returning
   `Record<hostname, idleSeconds>`. Add the matching bulk Vantra route
   `vantra/app/api/internal/sw/devices/idle/route.ts` (`GET ?orgId=`) if a
   per-agent loop would mean N calls. **N+1 calls are not acceptable.**
4. `spaceworker/app/api/devices/route.ts`: add `idleSeconds: number | null` to each
   row, resolved from (3) **best-effort** — if Vantra is unreachable or the user has
   no linked org, still return **200** with `idleSeconds: null`.

### C — Live refresh (SpaceWorker UI)

5. `spaceworker/components/device-list.tsx`: poll `/api/devices` (+ the link panel)
   every **20 s**, and **pause while the document is hidden**
   (`document.visibilityState`) so a background tab does not hammer the API. Keep
   the manual Refresh button. Clear the interval on unmount.
6. `components/device-list.tsx` + `components/device-console.tsx`: render idle
   beside status — `online · active now` / `online · idle 12 min` /
   `offline · last seen 3 hr ago`. Use `formatIdle`; never print raw values.

## Out of scope

- Do **not** sample idle or store it in the DB (live data, derived on read — plan
  RULE 2: telemetry is a bounded, whitelisted class).
- Do **not** touch the clone/schema work (`TASK_107+`).
- Do **not** change the console's existing 15 s poll beyond adding idle.

## Acceptance (owner runs after deploy)

- `tsc --noEmit` clean; local `npm run build` green.
- Idle route: unauthenticated → **401**; unknown/invalid `agentId` → **404**
  (not 403, not 500); offline device → `online: false` and a non-crashing value.
- List shows a device going online **without** pressing Refresh (≤20 s).
- Hidden tab makes **no** polling requests (verify in the server access log).
- Vantra unreachable → device list still renders with `idleSeconds: null`.

## Report back

Files changed · `tsc` result · exact route paths added · anything left unverified.

