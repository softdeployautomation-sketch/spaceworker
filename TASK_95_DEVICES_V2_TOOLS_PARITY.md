**Status: ✅ DONE (confirmed 2026-09-26, stale doc — never had its status line updated).**
Every row in §0's table, every schema addition in §2, every Vantra route in §3, every SpaceWorker
route in §4, and every UI surface in §5 already exists and is live: `lib/device-tools.ts` exports
`fetchMeshUrls`, `executePinRequest`, `startMaintenanceOverlayAction`/`stopMaintenanceOverlayAction`,
`createQueuedCommand`/`listQueuedCommands`/`cancelQueuedCommand`, `runCommandNow`, `runPowerAction`
(21 exported tools total) — built across TASK_103/104/108/114/119/122/123 without this doc ever
being revisited. `components/device-console.tsx`'s Control/Tools/Activity tabs match §5 exactly.
Nothing left to build here.

# TASK_95 — Devices v2: every Vantra tool, redesigned, working (OWNER-SIGNED DIRECTION)

> Owner directive 2026-09-21: "take the tools we have in spaceworker/VANTRA, i want ALL working —
> remote control, maintenance tool, pin request, timer/timed command for offline device, timed
> PowerShell for Wilk, silent install like the VM." This doc scopes that; the Browser Clone (P2)
> is grounded on it — no monitoring/remote tooling = no way to test browser control.

## 0. Verified mechanics (read from code, not guessed)

| Tool | Vantra source | Reaches SpaceWorker today? | Plan |
|---|---|---|---|
| Remote control (MeshCentral screen/terminal/files) | `GET /agents/<id>/meshcentral/` → `{hostname, control, terminal, file, ...}` URLs; `/api/devices/[agentId]/mesh` wraps it | ❌ | New internal route `mesh-urls` on Vantra + SpaceWorker proposal kind `remote-control` (gated like every action) |
| Maintenance overlay (lock screen "in maintenance" image) | `POST /api/devices/[agentId]/maintenance-overlay` `{action: start|stop, customImageBase64?}` (≤2MB, png/jpg/gif magic-sniffed) | ❌ | Internal route `maintenance` + kinds `maintenance-start` / `maintenance-stop` |
| PIN request (Windows Security-style unlock prompt) | `lib/request-unlock.ts` `requestDeviceCredentialUnlock(agentId, {pinLength, callbackUrl, token})` — PowerShell WinForms prompt **as the logged-in user**, POSTs PIN to `callbackUrl`; scheduled variant `createScheduledCredentialRequest` (`next_boot`, default delay 20m) | ❌ | Internal route `pin-request` + kind `pin-request` (pinLength 4/6/8, optional schedule). **SpaceWorker hosts the callback itself** (§3) |
| Timed command for OFFLINE device (queued) | `QueuedAgentCommand` table + `POST /api/devices/[agentId]/queue-command` (`cmd`, `shell`, `timeout≤90`, `runAsUser`) — fired by telegram-device-check sweep on online transition | ❌ | Internal routes `queued-commands` (GET/POST/DELETE) + SpaceWorker `DeviceQueuedCommand` mirror (§2) |
| Live cmd / script (incl. PowerShell) | internal `sw/devices/[agentId]/action` `cmd` (sendRawCmd, powershell) / `run-script` | ✅ TASK_93 | Keep |
| Wake / reboot / shutdown | same route (`wakeAgent`, `rebootAgent`, `shutdownAgent`) | ✅ | Keep |
| Silent agent install | TRMM installer is silent by design (owner verified on VM .106 — no TRMM popup) | ✅ install-link flow | Keep; surface properly in Add-a-device |

## 1. Silent-install note (owner's Wilk ask)
The agent install is **already silent** (the VM install showed no TRMM popup — that's TRMM's
installer default). What CAN pop up on Wilk: our **PIN prompt** (by design — it must be seen to be
typed into) and the maintenance overlay (by design). A **queued PowerShell for Wilk** ("when he
comes online, pop the install/command") = the queued-command path in §2: queue it while Wilk is
offline; the sweep fires it the moment he checks in. TASK_96 keep-awake/WoL will make "asleep"
Wilk reachable for timed commands too.

## 2. Schema additions (SpaceWorker Prisma — one migration)
- `DeviceQueuedCommand`: id, deviceId, userId, shell, cmd, timeoutSeconds, runAsUser, status
  (`queued|sent|failed|cancelled`), vantraQueueId?, error?, createdAt, sentAt. Mirror of Vantra's
  model, keyed to OUR device (ownership in OUR db; the online-transition sweep stays on the
  Vantra side; SpaceWorker mirrors + polls status via the internal route).
- `DeviceAction.payload` + `AgentPendingAction.payload` already Json — new kinds reuse them.
- `DevicePinRequest`: id, deviceId, userId, pinLength, status (`pending|submitted|expired|failed`),
  tokenHash, expiresAt, createdAt, submittedAt, sourceIp? — ONE-TIME token like install links.


## 3. New Vantra internal routes (all `verifySwSecret`, all assert agent ∈ `sw-*` org)
- `GET /api/internal/sw/devices/[agentId]/mesh-urls` → `{urls}` from `getMeshCentralUrls`.
- `POST /api/internal/sw/devices/[agentId]/maintenance` → `{action, customImageBase64?, customImageExt?}` proxied to `start/stopMaintenanceOverlay`.
- `POST /api/internal/sw/devices/[agentId]/pin-request` → `{pinLength}` (4/6/8); callbackUrl =
  `APP_BASE_URL + /api/devices/pin-callback` (SpaceWorker public URL passed BY SpaceWorker in body);
  token minted on the SW side, passed through; Vantra injects it into the prompt script.
- `GET|POST|DELETE /api/internal/sw/devices/[agentId]/queued-commands` → proxy the three ops on
  `QueuedAgentCommand` (POST body `{cmd, shell, timeout, runAsUser}`).

## 4. SpaceWorker API surface (all session-authed, owner-only, ALL gated proposals)
- kinds extended on `POST /api/devices/[deviceId]/actions`: `remote-control`, `maintenance-start`,
  `maintenance-stop`, `pin-request`, `queue-command` — approval executes through the new internal
  routes. (wake/reboot/shutdown/run-script/cmd unchanged.)
- `GET /api/devices/[deviceId]/mesh-urls` — short-TTL session token issued on approval; the viewer
  fetches iframe URLs client-side (mesh URLs are the one output that must reach the browser).
- `POST /api/devices/pin-callback` — PUBLIC (no session; the device posts here): `{token, pin}` —
  verifies tokenHash+expiry, stores the pin on the request row, marks submitted; the user's
  Devices page shows "PIN ready" + copy. Attempt-limit + single-use.
- `GET/POST/DELETE /api/devices/[deviceId]/queued-commands` — list/create/cancel; SW mirrors rows.

## 5. UI — Devices v2 (Tailscale-calm list + Synology-style console tabs)
- List `/dashboard/devices`: summary chips, per-device rows (status-first, relative time), honest
  empty state, **Add-a-device collapsed section** containing install link (fixes "can't see link"),
  panic with confirm dialog.
- Console `/dashboard/devices/[deviceId]`: Overview · Control · Tools · Activity tabs:
  - **Control**: Remote control (approve → MeshCentral iframe: desktop/terminal/files), maintenance
    overlay start/stop (optional custom image), wake/reboot/shutdown as proposal cards.
  - **Tools**: Run script / PowerShell (live), **Queued commands** (offline devices — "runs next
    time it checks in", list + cancel), **PIN request** (4/6/8, optional next-boot schedule, shows
    PIN when submitted), Browser Clone placeholder (disabled, TASK_97).
  - **Activity**: DeviceAction + AgentActionAudit history.
- Every action = proposal card (create → approve → result); silent where the tool is silent,
  explicit where the device will visibly change (PIN prompt, overlay).

## 6. Build order (this session)
1. Migration + schema (DeviceQueuedCommand, DevicePinRequest).
2. Vantra internal routes (4) — deploy Vantra.
3. SpaceWorker lib (`lib/device-tools.ts`) + API routes + proposal kinds — deploy SW.
4. UI: list page + console with Control/Tools/Activity.
5. E2E on VM .106: remote control iframe, maintenance overlay, pin request, queued command;
   then queue the timed PowerShell for Wilk and verify it fires when he checks in.
