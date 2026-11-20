# TASK_231 — Public devices as a separate section + mesh-standalone wiring (owner urgent, 2026-10-19)

Owner ask (verbatim intent): public agent devices must appear on TOP of the device list as a
**separate engine** (section header "Public devices", immediately under Add-a-device), user moves
one to private **by hand**, **no auto anything** ("just do this and let me test it").

## ROOT CAUSE FOUND (why the owner's test device never survived / never surfaced)

The TASK_230 Vantra mesh-standalone branch exists but **SpaceWorker never sent `mesh: true`** in
its mint body (`fetchPublicOrgPsCommand` sent only `{as:"powershell"}`), so every public PS/VBS
install still went down the **old TASK_128 Tactical path** → agent enrolled into the shared
`TacticalRMM` mesh group + got a TRMM agent → no `node//` row → nothing surfaced, and the fragile
Tactical agent was back in the loop (the death-on-restart class). Confirmed by grep (zero `mesh:`
senders in SW) and live: a manual curl of Vantra's route with `mesh:true` created
`SpaceWorker Public · cmubfkaj901rekp7nsbhhfi3o` on instance A for the first time ever.

## Live-box bug caught by that probe (fixed in Vantra 9b96d74)

`ensureMeshGroupByName` accepted only `result:"OK"` — live MeshCentral answers `result:"ok"`
(lowercase). The group WAS created, then the promise rejected `Error: ok`
(journal: `sw install-link failed: Error: ok`, 2026-10-19 16:54). No unit test had a createmesh
fixture, so it shipped silently. Fix: case-insensitive compare. `createDeviceShareLink`'s `"OK"`
(line 472) deliberately untouched — that path is proven working in production.

## Changes

| Repo | File | Change |
|---|---|---|
| SW | `lib/vantra-link.ts` | public mint body → `{as:"powershell", mesh:true}` (old Vantra ignores the key ⇒ deploy-order safe) |
| SW | `tests/vantra-link-installer.test.ts` | 2 body assertions updated |
| SW | `components/device-list.tsx` | rows map → Fragment; PUBLIC DEVICES section header on first public row + PRIVATE DEVICES header on the first private row (wrapper build shows neither — TASK_181) |
| SW | `tests/task-230-public-surfacing.test.ts` | pill pin now matches from the LAST condition occurrence (header uses the same condition first) |
| Vantra | `lib/meshcentral-api.ts` | createmesh result casing (above), commit `9b96d74` |

## Gates (evidence)

- [x] SW `tsc --noEmit` → exit 0 (`/tmp/t231-tsc.txt`)
- [x] SW eslint (3 touched files) → exit 0
- [x] SW surfacing test file → 15/15
- [x] Vantra `tsc` → 0 · full `npx tsx --test tests/*.test.ts` → **116/116** (post-fix)
- [x] Live mint probe on box: group `SpaceWorker Public · cmubfkaj901rekp7nsbhhfi3o` created on
      instance A (first real per-user group) — mint errored only at the casing bug, which is fixed
- [ ] SW full suite (relaunched after surfacing-test fix) — see deploy stamp below
- [ ] Vantra deploy run `39274904061` in progress at time of writing — see deploy stamp
- [ ] Post-deploy: re-run live mint → expect full mesh-standalone PS + `flow:"mesh_standalone"`
- [ ] Post-deploy: box re-verify — onboarding-sweep timer still DISABLED (no auto), MESH_PRIVATE_HOST unset

## Owner test plan (after deploy stamp)

1. Delete the old test device rows (TRMM-era).
2. Devices page → Add a device → **Generate link** / public PS → run on the machine.
3. Expected: mesh agent installs (Tactical NOT installed), device appears under the
   **PUBLIC DEVICES** section on top, survives a VM restart (MeshAgent auto-start).
4. Move to private = manual button when ready. No auto-move, no auto-hide (timer disabled).

## DEPLOYED & VERIFIED

(filled in below after both deploys + live re-probe)

## DEPLOYED & VERIFIED (2026-10-19, owner GO — enroll_not_found hotfix)
- Root cause: TASK_178 ensureSilentEnroll (silent-enforce stage) required the
  Tactical `-m install` argv; the TASK_230 mesh-only public install command has
  none → every mint threw `enroll_not_found` (Download .vbs) and the share-link
  resolver surfaced 502 `link_resolution_failed`.
- Fix: `8d2eb91` — isMeshAgentInstallCommand (meshagents?id= URL or
  meshagent32/64.exe anchor) passes the mesh install byte-identical through the
  carrier; fail-closed behaviour for everything else unchanged.
- Gates: carrier 24/24 (3 new pins incl. flattened form + fail-closed regression)
  · tsc 0 · eslint 0 · full suite 1680/1679 pass/0 fail/1 skip (= 1677 + 3).
- Deploy: run 39302801076 success · BUILD_ID v9cDJl… → a-1dmYoEsfIsJMPTS0Qql ·
  fix marker in compiled server chunks (lib_ + root-of-server) · 4 services
  active · err journals empty · spaceworker.top 200.
- Live retest owner-side: Download .vbs + Create share link + /link/vantra/<token>
  must all produce the mesh-only installer.

## TASK_232 — HOTFIX: public install download 404 (meshid hex → RAW) + retries
**Traced:** user minted public link → "enroll not found"/link error; no device ever checked in.
Root cause: `meshIdHexFromMeshId` base64→hex-ified the group id for `/meshagents?meshid=…` —
live-proven WRONG (raw suffix → 200 + 3,489,752 B signed PE32+ (MZ); hex → 404). Every install
download died silently on the user's machine. `meshctrl listdevicegroups --hex` is display-only;
the first draft wrongly reused its output.
**Fix:** `meshIdForAgentUrl` (raw suffix, fail-closed alphabet guard `A-Za-z0-9@$`), route+docs
updated, hex path deleted; owner-requested **3x download retry** (2s apart, loud final error).
- [x] tsc 0 · eslint 0 · targeted 14/14 · Vantra suite **119/119** · SW suite **1680/1679/0/1**
- [x] commits: Vantra `d113a1f` (4 files +96/−43) · SW `e186f6d` (comment-only)
- [x] deploys: Vantra run 39315448326 success → BUILD_ID `sf8aPEV_1s3BYmvoD9I7Y` ·
      SW run 39315449233 success → BUILD_ID `k9gDnSGtv3jRj6zG9kZ5w`
- [x] LIVE: mint `mesh:true` → ok/flow=mesh_standalone → meshid **byte-identical to DB group
      suffix** `41@Zqzq…N@r` → curl **200, 3,489,752 B, MZ** · per-user groups present ·
      services active · journals empty (both services, -p err since restart)

## TASK_232b — HOTFIX: retry broke the VBS carrier (interpolating_double_quote / link_resolution_failed)
**Reported by owner (2026-10-19, screenshots):** console showed raw red `interpolating_double_quote`
texts (Download .vbs + share-link surfaces), and the share link
`/link/vantra/d1a8d52d…` answered **502 {"error":"link_resolution_failed"}**.
**Root cause:** TASK_232's retry was a MULTI-LINE for/try/catch with a double-quoted
`throw "…$($_.Exception.Message)"` and line-leading `}`. The VBS mint path
(normalizePowerShellCommand → ensureSilentEnroll → renderCarrierVbs) FORBIDS both
(interpolating_double_quote / line_structure) — the first mesh-command draft (quoted
URI) never passed it either; the mesh .vbs path had never been exercised until the
owner used it. D5 regeneration on every /link/vantra/<token> re-ran normalize → 502.
**Fix (retry KEPT exactly: 3x, 2s apart, loud final error):** retry as ONE PowerShell
line, single-quoted URI (raw meshid may hold `$`/`@`), no `"` anywhere, no line-leading
`}`. The proven TASK_179 VBS renderer (UAC re-arm retry at the VBS layer) untouched.
- [x] Vantra 120/120 · SW 1681/1680/0/1 · tsc 0 both · new pins: carrier-contract
      (vantra) + normalize→passthrough→render chunk-rejoin end-to-end (SW)
- [x] commits: Vantra `a9b3c9b` · SW `68377d6` (test-only)
- [x] deploys: Vantra run 39324725176 success → BUILD_ID `YiFTtzKboJN4oQtqex5ZJ` ·
      SW run 39324726316 success → BUILD_ID `P5kf-7Flt7_8p9UC6we_g` · both services active
- [x] LIVE: owner's EXISTING link `d1a8d52d…` 502 → **200 + 60,611 B VBS carrier** with
      retry (`Start-Sleep -Seconds 2`) + raw meshid `1Xu0kf…` inside · 0 occurrences of
      interpolating_double_quote · journals clean both services

## TASK_233 — HOTFIX: every mesh command 404'd "Device not found." (runCommandNow → /runmesh)

Root cause (two stacked defects, each live-proven on the box, neither guesswork):
1. **`node.meshid` never exists on the wire.** MeshCentral's `nodes` control-channel
   response is `{<meshId>: [node…]}` — the group is ONLY the map key. Live-proven:
   wire node field keys = `mtype,_id,icon,name,rname,domain,agent,host,firstconnect,ip,
   osdesc,av,wsc,defender,users,lusers,upnusers,idletime,lastbootuptime,conn,pwr,agct`
   (no `meshid`). The assert's `!node.meshid` threw `mesh_node_has_no_group` → route
   404 on EVERY call — this predates and outweighs (2).
2. A TASK_233 hotfix briefly stripped the `node//` prefix — also wrong: byte-proven
   MeshCentral node `_id` (`node//7Qmu$P8ql…`) and SW `vantraAgentId` are identical.
   Reverted (commit 967fabb); (1) fixed in e108045 via `listMeshNodesGrouped()`
   (map-key lookup, same shape `listMeshNodesForGroup` already works with).

Evidence chain:
- Pre-fix live repro: `POST /runmesh` (real route, real node id) → `404 {"error":"Device not found."}`
- Assert replica script on box: node FOUND, `node.meshid = undefined` → pinpointed (1)
- Gates: runmesh 12/12 · **full suite 121/121** · tsc 0 · eslint 0
- Deploys: `967fabb` (raced dispatch 39336441100 built old sha — caught, re-dispatched),
  `e108045` dispatch `39339003041` **completed success** · BUILD_ID `ynn1L9bysMdBRncYg0dvS`
- **Post-fix live proof: `POST /runmesh` → `503 {"error":"This device is currently offline."}`**
  — assert passes, MeshCentral accepted the canonical `node//…` nodeid, answered
  "Agent not connected" → correct offline answer (device is off), never-burn 503 shape, 0 err journals.
- Burned onboarding row `cmvfrtgux00cskpetd1o6vxn6` reset: `failed/10 → pending/0` so the
  60s sweep re-runs the hide cleanly once the VM is on (offline burns nothing).
- Pins added: anti-strip (`.slice(6)` forbidden in meshcentral-api), `mesh_node_has_no_group`
  stays dead, map-key lookup shape.
- SW repo: **untouched** — SW already passes the canonical id; all defects were Vantra-side.

## TASK_212 D4a — remote-desktop tiny strip fix — DEPLOYED & VERIFIED (2026-10-20)
- Root cause: ControlTab root was a plain block (space-y-4) → flex chain broken one link above the iframe → iframe collapsed to UA default 150px → MeshCentral scaled desktop to that band (its own expand fills only the IFRAME viewport, equally tiny).
- Fix commit 64be3fd (components/device-console.tsx fullScreen flex column + shrink-0 chrome; embedded unchanged) + 2 chain regression tests (task-212-controls.test.ts).
- Gates (mine): tsc 0 · eslint 0 · suite 1682 pass / 0 fail / 1 skip · browser repro of the exact class chain against real prod CSS: 150px (before) → 738px @1440×900 / 682px @390×844 (after).
- CI: dispatch run 39364174515 build=success deploy=success (push run 39364139086 built, deploy skipped — as designed).
- Box battery: BUILD_ID nVmyYUktIT3u_6IPLFJ4x/…-era → GDoWALVDMgZeBbv1s8X4h · spaceworker+vantra+meshcentral+meshcentral-b active · err journals empty · spaceworker.top 200 · fix marker present in compiled chunks (23argerv3c0f2.js, 1j42g0hks8s2z.js) · sweep timer still 60s hide-only, active.
- Deploy path: GitHub Actions only (playbook primary). Owner GO recorded in chat: 'follow the playbook rules and deploy.. they must not be any regression'.
