# TASK_234 — Mesh command OUTPUT + move-to-private (owner: "make the command output / run, then move works, then delete from public")

Owner GO: 2026-10-20 ("yes go… just test and deploy… be fast"). Device I VM is ONLINE for live proof.

## Branches
- SpaceWorker: `agent/task-234-move-private-flow` (off main ea0f92a)
- Vantra: `agent/task-234-mesh-cmd-output` (off main dd2af25)

## A. Command output (mesh-only rows) — TERMINAL RELAY, CODE DONE, NOT DEPLOYED

Root cause (box-proven, TWICE): MeshCentral v1.2.4's `runcommands` wire NEVER
returns command output — meshuser.js acks 'OK' synchronously and meshagent.js
has NO runcommands case (the agent's execution result is dropped server-side).
The original sink wrap (agent POSTs output back) rode that dead dispatch:
the wrapped command ran nothing retrievable, zero ingest POSTs ever arrived
(nginx-log-proven). 

FIX (the protocol MeshCentral's own web console + `meshctrl shell` use):
- [x] Vantra `lib/mesh-terminal-output.ts` — PURE: stripAnsi (CSI+OSC),
      endsWithPrompt, extractTerminalOutput (echo/banner/prompt cut; the echo
      head is cut at the LAST full occurrence because PSReadLine re-renders
      the paste per frame). Fixtures = REAL wire bytes captured from Device I
      (probe /tmp/wt4.log on the box, 2026-10-20).
- [x] Vantra `lib/meshcentral-api.ts` → `runMeshTerminal()`: control.ashx →
      authcookie → tunnel msg (usage:1, p=6 PS / p=1 cmd, node// VERBATIM —
      pin 14) → relay ws → agent 'c'/'cr' → options JSON + TEXT "6"/"1" →
      wait for first prompt (boot ~8-21s, cap 45s) → command as BINARY
      Buffer(cmd+"\r") → collect until idle-after-prompt or budget → extract.
      THREE wire traps encoded (each burned a probe cycle): handshake byte is
      the TEXT "6" (Buffer([6])=0x06 never boots PS); post-handshake input
      MUST be binary (text frames are swallowed silently — zero echo);
      sending before the first prompt eats the command. Honest null; partial
      output on drop/timeout; boot/hard-timeout → mesh_run_failed 502;
      never-handshaked relay close → 503 never-burn.
- [x] Vantra `runmesh` route — `captureOutput:true` → runMeshTerminal;
      NO captureOutput → byte-identical old dispatch (**pin 10**: sweep
      unchanged). The sink wrap is REMOVED from the route (mesh-cmd-output
      module + ingest route remain deployed but unused — dead code, kept to
      avoid a remove-deploy this cycle).
- [x] SW `runCommandNow` `captureOutput?` flag → body adds
      `{captureOutput:true, timeoutSeconds}` ONLY when set; interactive callers
      set it: run-command route, device-tools 661/1949/2107, clone-setup,
      security-audit. Sweep deliberately does NOT. (SW unchanged this cycle.)

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
- [x] **B3** Vantra `/move` — mesh branch DONE: `node//` id →
      `assertMeshNodeInSwPublicGroup` → group `SpaceWorker Public · <uid>` →
      source org `sw-<uid>`, dest `sw-<uid>-p`, then the SAME install-plan
      body (createManualInstaller). Was 404: `assertAgentInSwOrg` is
      TRMM-only (getAgentDetail throws TRMM 404 for `node//`).
      Helper ADDED in meshcentral-api: node→group lookup inside
      inside `assertMeshNodeInSwPublicGroup` refactored to also return the
      group name so the route can parse `<uid>` (grep confirmed:
      `swUserIdFromOrgName` + `SW_ORG_PREFIX` in spaceworker-service.ts; group
      builder `SpaceWorker Public · ${uid}` in mesh-standalone-install.ts:47).
- [x] **B4** Vantra `/action delete` — mesh branch DONE: `node//` → public
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
- [x] **B4-SW check** — SW sends `node//` id through unchanged (pin 14), group never in the id; covered by green `tests/task-234-move-capture.test.ts`.

## C. Gates (own, re-run, never trust counts) — GREEN, RE-RUN CONFIRMED
- [x] tsc 0 both repos (`/tmp/t234b-tsc2.log` = 0 lines Vantra;
      `/tmp/t234-sw-tsc3.log` = 0 lines SW)
- [x] eslint changed files 0 both repos (VT ESLINT=0 on
      mesh-terminal-output/meshcentral-api/runmesh/both test files)
- [x] suite ×2 Vantra **154/154/0/0** (`/tmp/t234b-suite2.log` + rerun, both
      exit 0; first run `/tmp/t234b-suite1.log` caught 1 fixture bug —
      banner-keep case — fixed + rerun per protocol). SW **1689 pass / 0 fail /
      1 skipped** (baseline skip). New tests this cycle: terminal extraction
      against the REAL captured wire session (Get-Date → "20 October 2026
      13:59:43"), ANSI strip, prompt detection, echo-less output preserved,
      pin-18 source pins (TEXT "6", BINARY input, prompt-gated send), runmesh
      sink-never-returns pin.
- [x] secret-scan diff (import line only; no literals).

## D. Deploy + post-deploy battery — owner GO given ("test and deploy")
- [ ] Commit w/ attribution → merge main → push (both repos).
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
