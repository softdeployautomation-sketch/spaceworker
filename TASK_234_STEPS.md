# TASK_234 — Mesh command OUTPUT + move-to-private (owner: "make the command output / run, then move works, then delete from public")

Owner GO: 2026-10-20 ("yes go… just test and deploy… be fast"). Device I VM is ONLINE for live proof.

## Branches
- SpaceWorker: `agent/task-234-move-private-flow` (off main ea0f92a)
- Vantra: `agent/task-234-mesh-cmd-output` (off main dd2af25)

## A. Command output (mesh-only rows) — CODE DONE, UNCOMMITTED, NOT DEPLOYED

Root cause (box-proven earlier): MeshCentral `runcommands` wire NEVER returns
command output (ack = "OK"/"Agent not connected" only) → console showed
`output:null` forever. Fix = agent POSTs captured output back to a one-shot sink.

- [x] Vantra `lib/mesh-cmd-output.ts` — 24-byte token sink: one-shot, TTL =
      timeout+15s (clamp 5s..120s), 256 KB clip, cancel-on-dispatch-fail,
      `wrapCmdForOutputCapture` (powershell: scriptblock + Out-String +
      Invoke-RestMethod; cmd: temp file + curl.exe). Ingest base =
      `VANTRA_INGEST_BASE_URL` || https://vantra.spaceworker.top (public — no
      middleware.ts exists in vantra, route guards itself: token = the auth).
- [x] Vantra `app/api/internal/mesh-cmd-output/[token]/route.ts` (1064 B).
- [x] Vantra `runmesh` route — `captureOutput:true` → wrap, await sink
      (honest `null` on timeout), `cancelCmdOutputSink` on dispatch fail;
      NO captureOutput → byte-identical old body (**pin 10**: sweep unchanged).
- [x] SW `runCommandNow` `captureOutput?` flag → body adds
      `{captureOutput:true, timeoutSeconds}` ONLY when set; interactive callers
      set it: run-command route, device-tools 661/1949/2107, clone-setup,
      security-audit. Sweep deliberately does NOT.

## B. Move-to-private → duplicate → delete public

Flow owner wants: click Move → get PS install command → run it on the box →
**private copy appears (duplicate)** → verify safe → **delete public row**.
Duplicate IS possible: public = MeshCentral agent, private = Tactical agent —
different agents, both can run on one machine.

- [x] **B1** SW `MoveToPrivateResult` rewritten: `{ok, flow, destinationOrgId,
      destinationOrgName, steps, install:{command}}` matches Vantra's real
      TASK_230 response (the old `{ok:true,moved:true}` was fiction — that's
      why `install.command` was dropped at the type line).
- [x] **B1** SW move-to-private route now passes the whole plan through
      (`flow/destination*/steps/install`) instead of `{ok:true}`.
- [x] **B2** UI: `moveDeviceRow` confirm copy fixed (no more "agent restarts
      once" — retired live-reconfig); success with a command now sets
      `moveInstruction` state instead of a silent `load()`.
- [x] **B1** UI panel rendered after the header: masked `<pre>` +
      Reveal/Hide + copy gated on reveal (`copied === "move-install"`) +
      "Done — I ran it" → clears + `load()`. Same posture as public PS.
- [ ] **B3** Vantra `/move` — mesh branch (NEXT): `node//` id →
      `assertMeshNodeInSwPublicGroup` → group `SpaceWorker Public · <uid>` →
      source org `sw-<uid>`, dest `sw-<uid>-p`, then the SAME install-plan
      body (createManualInstaller). Currently 404s: `assertAgentInSwOrg` is
      TRMM-only (getAgentDetail throws TRMM 404 for `node//`).
      Helper to add in meshcentral-api: node→group lookup already exists
      inside `assertMeshNodeInSwPublicGroup` — refactor to also return the
      group name so the route can parse `<uid>` (grep confirmed:
      `swUserIdFromOrgName` + `SW_ORG_PREFIX` in spaceworker-service.ts; group
      builder `SpaceWorker Public · ${uid}` in mesh-standalone-install.ts:47).
- [ ] **B4** Vantra `/action delete` — mesh branch (NEXT): `node//` → public
      group assert (404 else) → best-effort UNINSTALL dispatched via
      `runMeshCommand` (self-locating PowerShell: find service whose PathName
      matches meshagent / name `MeshCentralAgent`, run its exe `-uninstall` —
      symmetric with the proven `-install`; `-uninstall` string confirmed in
      meshcentral tree) → remove the node record via meshuser wire
      `removedevices {nodeids:[<node// verbatim>]}` (handler confirmed in
      meshuser.js ~2856, `validateArray(command.nodeids)`) → answer
      `{ok:true, output:null, deleted:true}` (same shape SW expects).
      Uninstall is best-effort fire-and-forget (TRMM deleteAgent posture) —
      node removal proceeds even if uninstall output is null/offline agent.
      Offline: uninstall dispatch returns "Agent not connected" → proceed to
      record removal anyway? DECISION: NO — offline agent would RE-REGISTER
      the node on next connect (it holds the meshid locally) → refuse delete
      on offline with the existing 503 "currently offline" shape (same
      never-lie posture as runmesh).
- [ ] **B4-SW check** which SW call path drives delete for mesh rows
      (`removeDevice`/`removeDeviceRow` → vantra `/action delete`?) — verify
      SW sends `node//` id through unchanged (pin 14).

## C. Gates (own, re-run, never trust counts) — NOT YET RUN
- [ ] tsc 0 · eslint changed files · suite ×2 (both repos) · secret-scan diff
- [ ] New tests: sink one-shot/TTL/clip; wrapper shapes; runmesh capture branch
      + no-capture pin; move mesh guard; action delete mesh branch; B1
      passthrough (route returns install.command).
- [ ] Commit w/ attribution → merge main → push.

## D. Deploy + post-deploy battery — NEEDS 🚦 (owner said "test and deploy" = GO)
- [ ] Dispatch `Build & Deploy` BOTH repos (CI-from-main only).
- [ ] New BUILD_IDs · fix marker in manifest-referenced chunk (pin: orphan
      chunk check — manifest + mtime, never bare grep) · services active ·
      journals empty · public 200s · anon 401s (**pin 16**: probe
      vantra.spaceworker.top for internal API).
- [ ] LIVE PROOF on Device I (VM online): ① run command in public console →
      REAL output shows; ② Move → command displayed → run it → private copy
      appears (duplicate) ; ③ Remove public row → gone, private intact.
- [ ] Stamp this file · refresh PROMPT §9 + baseline + new pins · report table.

## Pins in force this task
10 (sweep byte-identical) · 13 (VBS carrier — move command is UI-shown, not
carrier-bound; install script from createManualInstaller already carrier-safe)
· 14 (mesh `_id` verbatim `node//`, group only in map key) · 16 (probe host) ·
17 (manifest+mtime before trusting chunk grep) · NEVER set MESH_PRIVATE_HOST.
