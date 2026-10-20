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

## B. Move-to-private → duplicate → delete public — bugs FOUND, fixes NEXT

Flow owner wants: click Move → get PS install command → run it on the box →
**private copy appears (duplicate)** → verify safe → **delete public row**.
Duplicate IS possible: public = MeshCentral agent, private = Tactical agent —
different agents, both can run on one machine.

Bugs (evidence in code):
- [ ] **B1** SW `MoveToPrivateResult` says `{ok:true,moved:true}` but Vantra
      returns `{ok:true, flow, install:{command}}` → SW route answers client
      `{ok:true}` → **the install command is dropped on the floor**. Fix: type
      + route passthrough + UI reveal/copy panel (mirror publicPs pattern,
      `maskCommand`/`copyText`).
- [ ] **B2** UI confirm copy still says "agent restarts once" (retired
      live-reconfigure, §Decisions LOCKED #3). Replace with install-command copy.
- [ ] **B3** Vantra `/move` guard = `assertAgentInSwOrg` (TRMM) → **404 for
      `node//`** → Move button dead on every public mesh row. Fix: mesh branch —
      group name `SpaceWorker Public · <uid>` → org `sw-<uid>`, then same
      source/dest/install logic (createManualInstaller, private org `-p`).
- [ ] **B4** Vantra `/action delete` guard = same TRMM assert (`grep 'node//'
      /action → exit 1` = zero mesh handling) → **Remove button 404s on mesh
      rows**. Fix: mesh branch — assert public group, best-effort uninstall via
      runMeshCommand (`-uninstall` string exists in meshcentral tree; service
      `MeshCentralAgent`), then `removedevices` wire (meshuser.js `nodeids[]`),
      answer `{ok:true, output:null, deleted:true}` like TRMM path.

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
