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
