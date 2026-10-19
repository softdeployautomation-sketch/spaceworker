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
