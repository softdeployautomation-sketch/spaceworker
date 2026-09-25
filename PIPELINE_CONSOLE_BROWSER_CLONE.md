# Pipeline — Device Console & Browser Clone (tracker)

**Status: OPEN — this file is the single tracker for the console + clone work.**

## How this pipeline works (read this first)

1. The **owner** hands one task file to one agent (paste the path, say "treat this").
2. The **agent implements and COMMITS ONLY** — no deploy, no VPS, no `.env`, no
   `prisma migrate deploy`. See the standard contract below.
3. The **owner verifies and deploys** (build → migration → restart → live check)
   using `HOW_WE_MOVE_FAST.md` §0–§3, then flips the task's status line in this
   tracker.

### STANDARD AGENT CONTRACT (every bit in this pipeline)

> **COMMIT ONLY. DO NOT DEPLOY.**
> - Work on branch `agent/<task-slug>` (or a fork PR per `MICHAEL_BRIEF.md`).
> - `npx tsc --noEmit` must be clean in **both** repos if both are touched.
> - **Never** edit, create or rsync `.env`; never ssh the VPS; never run
>   `prisma migrate deploy` / `npm run build` on the server.
> - Hand-write the migration SQL (never `migrate dev`); mirror the style of the
>   existing migrations.
> - **Never** write JSX/PowerShell through a shell heredoc — use the file editor,
>   then verify (`HOW_WE_MOVE_FAST.md` §6).
> - Stay inside the task's declared file list. If you must go outside it, stop
>   and ask — do not improvise scope.
> - End your run by reporting: files changed, `tsc` result, and anything you
>   could not verify locally.

### Mandatory reads for every bit

- **`HOW_WE_MOVE_FAST.md`** — deploy discipline, §6 gotchas (append-only).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** — §CROSS-TRACK RULES 1–8 (one gate,
  secrets classes, shared primitives, admin limits, manual-parity), §PRIORITY P2.
- **`DESIGN_DEVICES_PAGE.md`** + **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** for
  anything user-facing.
- **`MICHAEL_BRIEF.md`** if the work is a fork/PR deliverable.

---

## The bits (order = recommended pick-up order)

| # | Task file | Scope | Depends on | Status |
|---|---|---|---|---|
| C1 | `TASK_106_DEVICE_IDLE_AND_LIVE_REFRESH.md` | Device idle time (MeshCentral `idletime`) + live auto-refresh of the device list | — | **DONE · DEPLOYED · VERIFIED 2026-09-23** (both halves live) |
| C1-fu | (no new file — owner request) | **One last-seen per screen**: the duplicate display was removed in BOTH surfaces; the freed list cell is reserved for Ping (C2/MISSING-1) | — | **DONE · DEPLOYED 2026-09-23** |
| C2 | `TASK_103_CONSOLE_FULLSCREEN_TOOLBOX_SPLIT_PING_REBOOT.md` | ⤢ true full-screen console, toolbox split (4 groups), **Ping**, **Reboot** | — | RECORDED |
| C3 | `TASK_104_OVERLAY_SHELL_POPUPS_AND_SILENT_LAUNCHER.md` | Overlay shell-popup (Start menu / right-click) debug + silent app launcher toolbelt | — | RECORDED |
| G1 | `TASK_105_RESOURCE_GOVERNOR_QUEUE.md` | Server-side resource governor that queues high-RAM features | — | NOT STARTED |
| B1 | `TASK_107_CLONE_SCHEMA_AND_ADMIN_CAPS.md` | Verify the paused CloneJob migration + admin cap/TTL settings | — | **DONE · DEPLOYED · VERIFIED 2026-09-23** |
| B2 | `TASK_108_CLONE_AGENT_TRANSPORT.md` | Vantra-side clone endpoints on the shared Device layer (capture / receive+inject / launch / revoke / relay) | B1 | **DONE · DEPLOYED · VERIFIED 2026-09-23** (7 routes live; 401/404/400/503 boundaries proven; guard 500→404 hotfix `23f9919`; owner-only: real device capture/launch) |
| B3 | `TASK_109_CLONE_ORCHESTRATOR.md` | SpaceWorker `lib/clone.ts` state machine + TTL + panic + staging lifecycle | B1, B2 | **DONE · DEPLOYED · VERIFIED 2026-09-24** (57/57 live harness; relay fails closed before capture; panic via the real route; owner-only: real device capture/launch) |
| B4 | `TASK_110_CLONE_API_AND_GATING.md` | Clone API routes + premium gating + governor/caps enforcement | B3, G1 | **DONE · DEPLOYED · VERIFIED 2026-09-24** (20/20 live harness; 5 routes live; owner-only: real device capture/launch, direct-403 copy, 202 copy) |
| B5 | `TASK_111_CLONE_CONSOLE_UI.md` | Browser clone tab + Summary card + history + full-screen session window | B4, C2 | **DONE · DEPLOYED · VERIFIED 2026-09-24** (3 files live; tsc clean local + server build `✓ Compiled successfully`; `/clone/[cloneId]` route in build output; service active, landing/login 200, clone APIs unauth-gated, UI copy in shipped chunks; owner-only: real browser render + click-through with a physical device) |
| B6 | `TASK_112_CLONE_EXPIRY_AND_PURGE.md` | TTL sweep, staging deletion, 30-day inactive purge, relay health cron | B3 | **DONE · DEPLOYED · VERIFIED 2026-09-24** (13/13 live harness; unauth 401 + counts-200 + idempotent double-run; timer enabled+active, exit 0; counts-only journal; owner-only: real device capture/launch teardown) |
| C2-fu | `TASK_114_CLONE_DEVICE_SETUP_ONE_CLICK.md` | **One-click clone-device setup** — signed engine-bundle download + quarantine + relay/receiver install + capabilities, all over the agent (no hand installs); fixes the relay installer's `preflight` bug that made relay mode impossible | B2, B5 | **BUILT · DEPLOYED 2026-09-24** (engine bundle live at `/opt/spaceworker/engine-dist/` with 10 artifacts + manifest; `GET /api/devices/:id/clone-setup` → 200 read model incl. `hostedAvailable`; `POST` fails closed with 502 `device_offline`, no queue). **End-to-end install still needs an ONLINE device** — owner's PCs are currently offline (see OOB-3) |
| B7 | `TASK_117_HOSTED_POOL_PROVISIONING.md` | **Close the browser clone by REUSING the existing Neko private browser** as the clone destination — no hosted-PC pool, no new machine, no new load. Verified: `cmd/relay/main.go` already documents the relay as "the hosted clone's browser uses as `--proxy-server`", `browser-server/server.ts` already bind-mounts an arbitrary profile dir (line 225) and already injects `--proxy-server` (168-185), `pkg/injection/injector.go` already targets a POSIX host (`MountOwner`), and `pkg/crypto/password_handler.go` already writes Chrome-Linux `v10`/`peanuts` values. D2/D3(b)/D4 collapse into D1. | B4, B4-fu | **DECIDED 2026-09-24 (owner): reuse Neko** — "one browser is enough for all". **B7 is the active path to CLOSING the clone.** Next action: settle the single go/no-go (D1) — launch the container with `--password-store=basic` and prove a Windows `Sc` capture is signed in inside it. Everything after that is mechanical. Side effect: single-PC cloning becomes legitimate, so `self_only` must be retired. **UPDATE 2026-09-25 — the D1 go/no-go is SETTLED.** Mechanism proven on the VPS with no device (`TASK_117` "D1 FINDINGS" F6): a cookie injected via **browser-level `Storage.setCookies`** (no attach) was **received by the site on the wire** and **survived a full container restart**. Recipe: non-default `--user-data-dir` + `--remote-debugging-port` + a loopback forwarder, then the **browser** endpoint. **Do not** use a direct `/devtools/page/<id>` socket (completes the handshake, answers ping/pong, silently ignores every command) and do not rely on `Target.attachToTarget` (`-32000 Not allowed`). Disk-level injection is impossible — Chromium deletes foreign cookie rows (F4). Also found: the engine's Chrome KDF uses the wrong salt (`saltysalt`, not `peanuts`, F1) and ignores the 16-byte cookie prefix (F2). Only the real `Sc` signed-in capture remains; the recipe is now a verified repo script (`scripts/clone-cdp.mjs`). **UPDATE 2026-09-25 — D1 is CLOSED, and the disk route is DISPROVEN.** The `Sc` capture ran through the agent's route-as-user transport: `rows=85 decrypted=0 failed=85 schemes=map[v20:85]`. Windows Chrome 153 writes EVERY cookie with App-Bound Encryption, so out-of-process decryption is impossible (F10). The obvious workaround — copy the profile, launch our own Chrome on the copy, read it over CDP — DESTROYED the copy: 85 rows -> 0 rows, identical file size, all `v20` markers gone, because the ABE key is bound to the data-directory path (F11). Chrome 136+ additionally refuses remote debugging on the default profile (F12). **All three Windows capture routes are closed by design — a platform fact, not our bug.** RECOMMENDED way to close the clone: no cookie transfer at all — the hosted browser logs in for itself and egresses through the device (F10 route 3); Windows cookie import becomes a SEPARATE OPTIONAL build (enterprise policy, or a force-installed extension). The owner's original profile was verified untouched and the VM cleaned. `scripts/clone-cdp.mjs` gained `export` (reads cookies out of a live Chrome; `--domains` prints counts, never values). |
| B4-fu | `TASK_116_CLONE_HOST_AVAILABILITY_SINGLE_SOURCE.md` | **"clone host is ready" but Start says no host** — the Setup card and the gate each defined host availability differently (raw `status` column vs a 10-min heartbeat window) on a snapshot that has no timer, and the refusal pointed at a button on the same PC the user had already set up. One shared `hostAvailability()` + a throttled liveness refresh at each decision point + reason-specific copy | B4, C2-fu | **DONE · DEPLOYED · VERIFIED 2026-09-24** (`de6b0a1`) — see OOB-10 for the live evidence |
| B8 | `TASK_118_CLONE_HOSTED_DESTINATION_AND_LAUNCH.md` | **Make the clone DESTINATION real, then launch it** — the "destination" is **OUR Neko browser on our server** (owner's design: one browser on our side, one profile per clone job, egress routed through the device) — NOT a second PC and NOT the customer's machine; the old `deviceKind="hosted"` / "hosted clone PC" naming is misleading. Provision it(`deviceKind="hosted"`), teach the picker a hosted destination needs no agent, add a hosted launch path via `browser-server`, and build the relay data path | B7 | **B8-3 DONE + VERIFIED LIVE 2026-09-25** (`37e92b5`): dial-out tunnel client (`cmd/relay/tunnel.go` — control conn + one conn per stream) and the server ingress (`browser-server/relay-ingress.ts`, `browser-server/server.ts`, 13 tests via `npm run test:browser`). Proven over the real internet: `Sc` dialled OUT and a browser-path fetch returned **the device's own public IP `105.112.190.20`** — not ours (`164.68.105.96`) — over both plain HTTP and HTTPS/CONNECT, with no inbound port, firewall rule or router change on the device. **RECORDED 2026-09-25.** Four measured defects block "click Start": (1) `deviceKind="hosted"` is read in ONE place (`admin/clone-limits:54`) and written NOWHERE, so the pool is permanently 0; (2) `hostAvailability` filters `vantraAgentId: { not: null }`, so a hosted browser can never be picked (no agent); (3) `runCloneLaunch` is an agent RPC on the destination — no hosted path exists; (4) **the long pole** — the relay is loopback-bound (`RELAY_ADDR=127.0.0.1:8118`) and documented as "replayed over the Mesh tunnel", but **no TCP tunnel exists in either repo** (only the one-way parcel POST `/rmm/inject-clone`), so same-IP egress is currently UNREACHABLE, not merely unconfigured. Bits: B8-1 destination, B8-2 hosted launch, B8-3 dial-out relay tunnel, B8-4 retire `self_only`. Needs Q1 (hosted identity), Q2 (is our-IP interim acceptable — recommended NO), Q3 (tunnel shape). **B8-1 DONE + DEPLOYED + VERIFIED LIVE 2026-09-25** (`638f40d`, Claude — Cline started this bit and hit its usage limit mid-task; finished by diffing what was actually on disk against the design `lib/clone-destination.ts` itself documents, not by guessing from the transcript). New `lib/clone-destination.ts`'s `ensureHostedDestination(userId)` finds-or-creates the account's `deviceKind:"hosted"` row (idempotent by design, no unique-constraint migration — a documented trade-off, not an oversight); `hostAvailability()` now queries it and prefers it; `requestClone()`'s destination resolution calls it up front so the old `no_hosted_clone_device` refusal branch is now dead code and was removed. Two gaps Cline's session ended before closing: `cloneSetupStatus()` (the actual read model behind the console's setup card) never called `ensureHostedDestination()`, so a brand-new account's first card read would show "no host available"; and `GET /api/devices` had no filter at all, so the hosted infrastructure row would have leaked into the user's own device list. Both fixed. Verified live end-to-end with a disposable test user (cleaned up after): fresh account's first setup-card read → `hostedAvailable:true`; exactly one hosted row created; `hostAvailability` picks it; a second call is idempotent (no duplicate); real `GET /api/devices` HTTP call confirmed the hosted row is invisible while a real device still shows. `tsc`/`eslint` clean (one pre-existing, unrelated unused-var warning). Deployed per `HOW_WE_MOVE_FAST.md` §2 (build from `/opt/spaceworker`, not `/opt/spaceworker/app` — that line in §2's own snippet is the stale path §1 warns about). **B8-2 DONE + DEPLOYED + VERIFIED LIVE END-TO-END 2026-09-25** (spaceworker `91b15e6`, vantra `0c6db1b`, Claude). The real, complete clone flow now works — proven on production, not staged: `Sc`'s relay re-run through the ONE-CLICK setup route (not a manual SSH flag) came up in genuine dial-out mode; `POST /api/devices/Sc/clones` (relay egress) advanced `ready` → `active` through the real state machine; `HostedBrowserSession.egressIp` = `105.112.190.20` (Sc's own public IP, not `164.68.105.96`); the stamped `viewUrl` served a real Neko session (`200`, `<title>n.eko</title>`) through the actual public domain; revoked through the real API afterward — `CloneJob`→`revoked`, session→`stopped`, docker container removed, relay-ingress stream count back to `0`, Sc's own control connection correctly left up for the next clone.
| B9 | `TASK_119_LIVE_SESSION_COOKIE_STREAM.md` | **LIVE session mode** — an opt-in second clone mode that carries the user's **real logged-in session** into the clone; `fresh` (route 3) stays the default and byte-for-byte unchanged. **POC PASSED 2026-09-25** on disposable VPS infra only: CDP capture **in-process** (no disk read, no decryption — dodges F10/F11/F12), clone isolation (`cookies_total=0` before injection), CDP `Storage.setCookies` injection, and the **clone's own browser** carried the cookie to the server — proven by the server's own log, driven by a script, not hand-clicked. **Not proven and therefore the new build: capture from a REAL Windows Chrome** — that is the extension (`chrome.cookies.getAll()`, Part B = Cline); delivery/ingest/inject is Part A (`lib/cdp.ts` + a per-session CDP endpoint bound **host-loopback only** via the `swfwd` forwarder TASK_117 already scoped). Payload contract frozen in the task's B9-3 so the two parts never block each other. | B8, B7 | **RECORDED — Part A / Part B split, for pick-up** |


Two genuine architectural gaps found only by making this real, not by reading the spec:
1. **Chrome can't present the shared relay-ingress port's credential.** The B8-3 ingress design (Proxy-Authorization, gated by a per-job routing secret) mirrors the existing BYO-exit-node flow, which only works because Chrome remembers a one-time proxy-auth prompt inside a *persisted, reused* profile — a clone's profile is fresh every job. Fixed with a second, structurally different mechanism: a per-device, loopback-only, **unauthenticated** listener (`relay-ingress.ts`'s `openDeviceListener`) — the port itself is the trust boundary, no header Chrome can't supply.
2. **`install-relay.ps1` — the only production relay-install path — was never wired for B8-3's `-tunnel`/`-tunnel-key` flags at all.** Every existing "set up as clone host" click, including the one `Sc` used for the earlier B8-3 test, was loopback-only regardless. Fixed: `runRelayInstall` now enables dial-out by default for every install, using the device's own id as the tunnel key (no schema migration) and fetching the shared ingress token from `browser-server` via a new authenticated route rather than duplicating the secret into the main app's `.env`.

A third gap, in the state machine itself: `stepRequested` ran the full capture→transfer→inject pipeline unconditionally, so a hosted-destination clone (nothing to capture, per TASK_117's route 3) failed at `capture_no_clone_id`. Fixed: `PIPELINE_NEXT` gained a second legal edge out of `"requested"` (hosted destinations skip straight to `"ready"`), and three separate `!job.cloneId` guards (`stepLaunch`, `teardownTransport`, the crash-recovery path) — which all assumed every clone gets an engine-assigned id — were reordered so the hosted check runs first; a hosted job never gets one and never needs one.

**FOUND + FIXED 2026-09-25 by the owner's own real click-through test** (`2d0efd8`): the launched clone showed `ERR_PROXY_CONNECTION_FAILED` — the previous "verified live" pass never actually caught this because its egress-IP check ran on the HOST, and `openDeviceListener` had bound `127.0.0.1` (the host's own loopback), which is unreachable from *inside* the Neko container's own network namespace (where Chromium actually runs). Fixed: listener now binds `0.0.0.0`, gated by the same `isPrivateSource()` trust model the shared ingress port's browser path already uses, and `browser-server` now hands back the real reachable address (`DOCKER_BRIDGE_GATEWAY`, confirmed `172.17.0.1` on this host via `docker network inspect bridge`) instead of the caller guessing. Re-verified this time from *inside* the actual running container (`docker exec` + curl through the exact proxy address Chromium's own launch command uses) — real device IP came back. **Lesson for future verification on this pipeline: an egress/network check that runs on the host is not the same test as one that runs where the real client actually lives (a container, a customer device) — prefer testing from inside the real execution context, not just a process that happens to share the same box.**

**Remaining: B8-4 (retire the now-obsolete `self_only`/"you need one more PC" copy — trivial, no architecture left to resolve).** |


### Out-of-band (found during pipeline work — NOT clone-pipeline bits)

| # | Task file | Scope | Status |
|---|---|---|---|
| OOB-1 | `TASK_113_SCHEMA_DRIFT_DEVICE_LAYER_FKS.md` | Pre-existing Task-92 drift: 13 device-layer FKs are `ON DELETE CASCADE` in the live DB where the datamodel declares `RESTRICT` (+1 reversed RESTRICT→SET NULL, +1 index name). The DB currently **destroys** device/audit rows on delete — the exact thing RULE 5 forbids | NOT STARTED |
| OOB-2 | `scripts/deploy-vps.sh` + `lib/env-health.ts` (commit `28a1009`) | **Deploy-wipe incident 2026-09-24** — a `--delete --files-from` rsync whose list contained root-level files deleted every server-only runtime path at once: `.env` (extractor stuck "queued", private browser unconfigured, US/CA locations gone — all silent), `.next/` (`next start` crash-looped **37×** → public site down), `static/` (nginx's `error_page` target gone → raw 502s). Fixed: safe deploy wrapper (`--delete` opt-in, runtime hard-excluded, `.env` refused + snapshotted, chown, post-deploy assertion) and a boot-time `env-health` log line per degraded feature | **DONE · DEPLOYED · VERIFIED 2026-09-24** (site 200, extraction job done w/ 14 leads, browser session 201 + US exit `64.34.81.172`, picker present, all 6 internal units 200) |
| OOB-3 | (no new file — owner report) | **Clone egress is a provisioning gap, not a gate bug.** Live: account is premium (`/api/entitlements` → `premium:true`) and direct passes the premium check; the refusals are `relay_not_registered` + `no_hosted_clone_device`. Added fleet-level `hostedAvailable` to the setup read model + pre-flight blockers in the picker + actionable refusal copy naming the real buttons (commit `30be1ac`) | **DONE · DEPLOYED · VERIFIED 2026-09-24 — blocked on hardware**: no device has the relay or `clone-host` yet, and both owner devices are **offline**. Run one-click setup (Device setup card) once a PC is online |
| OOB-4 | (no new file — owner report) | Agent Hide/Reveal (MISSING-3, owner's **option 1**): rename service `DisplayName`s + set `SystemComponent=1` to drop the Apps row, Reveal restores VM-captured ground truth (`TacticalRMM Agent Service` / `Mesh Agent`). Already built in `lib/agent-visibility.ts` + wired to console buttons | **BUILT · DEPLOYED** — live VM click-through still pending (VM `192.168.0.103` offline at last check) |
| OOB-5 | (no new file — optional) | `SYSTEM_TEMPLATES_USER_EMAIL` is unset, so **ready-made campaign templates** (admin panel + Automations "Ready-made templates" group) are inert. Never set in prod — NOT a regression vs any backup | OWNER DECISION — set it to a dedicated non-sign-in account (e.g. `templates@spaceworker.top`), not a personal email, then author templates in the admin panel |
| OOB-6 | `TASK_115_OVERLAY_STYLE_CHOOSER.md` | **Overlay style chooser** (owner, 2026-09-24): two built-in looks — our existing PowerShell fake-Windows-Update screen (default, UNCHANGED) and the owner-supplied fake-update binary with the smoother spinner — plus "Maintenance with my image…" (PNG/GIF/JPEG upload, never stored). Binary read at **runtime** from a gitignored path with a pinned SHA-256, because both repos are PUBLIC and it is a third-party artifact. Cloud-trial evidence + the TASK_23 cursor caveat are in the task file; rollback = don't pick the spinner option | **DONE · DEPLOYED · VERIFIED 2026-09-24 (server-side)** — vantra `0273688` / spaceworker `5f7b889`; both builds `✓ Compiled successfully`, services active, site 200. Live probe: `style:"exe"` → `503 device offline` **proves the bytes loaded + SHA-verified** (the loader runs before transport); asset moved away → `503 "That overlay style is not installed on the server."` (clear message, **no silent fallback**), asset restored → verified again; real 1px PNG accepted, unknown style `400`; console route unauth `401`; both new labels in the shipped chunk. **Remaining (owner-only, needs an ONLINE device):** the 5 on-device checks — screen actually appears for each style, stop clears it, and technician mouse/keyboard still work under the exe style (the TASK_23 cursor risk) |
| OOB-7 | (no new file — owner report) | **Clone one-click setup: three defects found by running it twice + the real remaining blocker.** (a) The button **worked exactly once** — the receiver runs FROM the install dir and Windows locks a running `.exe`, so every re-run/repair failed with `Copy-Item … being used by another process`; (b) `STEP:stage:<n> OK` was printed **unconditionally** after `Copy-Item`, so that failure was invisible and the run blamed the *next* step; (c) a **partial `engine-dist/` deploy** was silently fatal — a targeted rsync of `install-hosted.ps1` + `manifest.json` after `scripts/engine-dist.mjs` rebuilt the binaries made every device die at `fetch:hack-browser-clone.exe FAIL:sha256_mismatch_8233984b`. Fixed in `8870af5`; `deploy-vps.sh` now verifies the whole set against its manifest and fails closed. **Verified on `Sc`:** full setup green end to end, task `Running`, receiver listening on `:8080`, hashes matching, staging clean, two concurrent clicks → `200` + `409 setup_already_running` | **DONE · DEPLOYED · VERIFIED 2026-09-24** |
| OOB-8 | (no new file — owner report) | **"Just confirm if it's the new exe that's in the flow" was unanswerable.** The overlay style is resolved inside Vantra, was returned to nobody, and SpaceWorker's `device_maintenance-start` audit row was `detail: null` — so two real starts on `Sc` (14:59:56Z / 15:03:25Z) cannot be attributed to a style. `startMaintenanceOverlay` now returns `MaintenanceStyleUsed` (`update` \| `exe` \| `custom-image`), the `sw` route echoes it, and SpaceWorker records `detail: { style, requested }` (vantra `e09d3f7` / spaceworker `afbe661`) | **DONE · DEPLOYED · VERIFIED 2026-09-24** (both builds `✓`, services active, site 200, unauth routes still `401`) |
| OOB-9 | (no new file — owner report) | **Browser clone is blocked on a clone HOST, not on egress.** Read from the DB, not guessed: the 14 rejections are all **05:16–10:48Z**, i.e. *before* the relay fix — `relay_not_registered` (9×) then `no_hosted_clone_device` (3×). Since the one-click setup the relay is **up** on `Sc` (`sourceReady: true`, `clone-host` + `clone-capture` + `relay`) and **no** `browser-clone` row has been rejected since. **No `CloneJob` has ever been created.** Remaining blocker: a clone's browser runs on a **different** device, so a clone needs **TWO online devices** — `Sc` (online, fully set up) and `WilkSF9` (**offline**, no caps). Fleet gap, not a code defect: per `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7 the hosted PC is meant to be **pooled/SpaceWorker-run** and that pool is only ever *counted* (`app/api/admin/clone-limits/route.ts`), never provisioned | **CORRECTED 2026-09-24 (owner directive) — the instruction that used to sit here was WRONG.** It told the owner to "bring the second Windows PC online and click 'Set up as clone host' on its console card". That second PC is a **customer's machine** (`WilkSF9`), and the clone host is supposed to be **SpaceWorker's own hosted PC** (`deviceKind "hosted"`) — a customer device must never host, test, or fall back for a clone, because a clone can raise a visible popup on their screen. What is actually missing is the **pool** (`deviceKind = "hosted"` is read in one place and written nowhere), now scoped in `TASK_117` (bit B7). Same-device hosting stays refused on purpose and is not the fix|
| OOB-10 | `TASK_116_CLONE_HOST_AVAILABILITY_SINGLE_SOURCE.md` | **"clone host is ready" but Start says no host.** Measured, not guessed: `Sc` had raw `status="online"` with a **20.8-minute-old** heartbeat, while a relay probe (a real agent round-trip) answered `up` **2 minutes** earlier — so the machine was provably reachable. The Setup card read the raw `status` column (no freshness rule); `pickHostedCloneDevice` applied `deviceStatus()`'s **10-minute** window; and that snapshot is written only by `syncDevices()`, which has **no timer** (a human opening the device list triggers it). The account's only `clone-host` *was* the source device, so the pool was empty and the refusal told the owner to press "Set up as clone host" — on the PC they had just set it up on. One PC can never host a clone of itself, and nothing on screen said so. Fixed: new `lib/clone-hosts.ts` with ONE `hostAvailability()` used by the gate AND the card, a throttled best-effort `refreshDeviceLiveness()` at each decision point, liveness accepted from EITHER signal (a false positive costs a clear "device offline" from the device RPC, which fails closed anyway; a false negative is the dead end this removes), and reason-specific copy (`self_only` / `offline` / `no_host`) on both the refusal and the pre-Start warning. Start stays **enabled** — the server remains the real gate | **DEPLOYED + VERIFIED 2026-09-24** (`spaceworker` `de6b0a1`, 5 files; md5 identical local↔server; server build `✓ Compiled successfully`; service active; site 200; `.env`/`.next`/`node_modules` survived). Live proof, all reversible, **no clone created**: (a) **liveness refresh works** — `Sc` was forced to `status="offline"` with a 1-hour-stale heartbeat, and one console poll put the row back to `online` with a fresh `lastSeenAt` (18:51:25Z), i.e. the frozen snapshot was corrected from Vantra; (b) **reason routing** — `GET /clone-setup` → `hostBlockReason:"self_only"`, `selfIsHost:true`; `POST /clones` → **409 `no_hosted_clone_device`** with the "one PC is not enough — set up a **second** PC" sentence; (c) granting a temporary `clone-host` to the *other* device flipped the reason to `offline` and **named it** ("Your clone host (WilkSF9) is offline"); (d) no side effects — `CloneJob` count `0`, the temporary capability row removed, `Sc` restored, session cookie deleted. Owner-only remainder: a second online PC |
| OOB-11 | `TASK_117_HOSTED_POOL_PROVISIONING.md` | **Owner directive: "sc is for testing and wilk is a customer … we cant just run test that could trigger a popup" + "the design is to clone a device browser and open it on our app with the proxy routing through the device".** Two prior documents had it backwards and both are corrected: (a) `TASK_114` told the owner to set a **customer's** PC up as a clone host and listed `Sc→Wilk` / `Wilk→Sc` clone options — withdrawn; (b) the same file claimed "a VPS cannot be the clone host … needs a real desktop session" — **false**: `runPreflight` documents a "POSIX hosted servers" branch, `pkg/browser/detect.go` resolves browsers from `PATH` first, non-Windows files exist (`dpapi_other.go`, `disk_free_unix.go`, `injector_posix_test.go`), and `DESIGN_…` §5 already states the engine "launches headless for validation" — which is also how the existing private-browser (`browser-server/` + Neko) already works. Also fixed here (`TASK_117`): the console copy that said *"You need one more PC set up as clone host"* now names the hosted PC as ours, on both the Clone-host badge and all three pre-Start warnings, and the server refusal tails match | **DONE · DEPLOYED · VERIFIED 2026-09-24** (copy fix only — the pool build is `TASK_117`) |
| OOB-12 | `TASK_117_HOSTED_POOL_PROVISIONING.md` | **Deploy hazard: runtime state inside the app root silently gives a STALE `.next`.** A copy-only deploy of `TASK_117` looked like it worked while the build had actually aborted, because `BrowserProfile.dirPath` is stored **absolute in the DB** and both rows still pointed at `/opt/spaceworker/browser-profiles/<id>` (the env base had already moved to `/var/spaceworker/profiles`), so the live Neko container bind-mounted the profile from inside the app root; `browser-server` also used `resolve("browser-sessions-tmp")`. Chromium writes **0600 files owned by `ubuntu`**, the build runs as `trmm`, and Turbopack indexes the project root — `Permission denied (os error 13)` → build dies. Fixed live: both dirs relocated under `/var/spaceworker/`, DB rows repointed (this also unbroke `deleteProfileDir()`, whose `assertSafePath()` threw for any path outside `BASE_DIR`), `SESSION_TMP_DIR` now honours `BROWSER_SESSIONS_TMP_DIR` / derives beside the profiles base, `.gitignore` hardened. Verified: build green in 17.4s, session mounts source `/var/spaceworker/...`, app root clean. **Rule: no mutable runtime state inside the app dir** | **DONE · DEPLOYED · VERIFIED 2026-09-24** (private browser re-checked end-to-end; no customer device touched) |


### Dependency graph

```
C1  C2  C3  G1        (independent console/ops bits)
             \
B1 ─┬─ B2 ─ B3 ─┬─ B4 ─ B5
    │           └─ B6
             (G1 feeds B4's caps enforcement)
```

### C1 deployed state (2026-09-23) — read before touching idle

**Shipped and live:** both halves are deployed (Vantra `0424b7b`, SpaceWorker
`589292f` + verify-fix `71853dd`), services active, builds clean.

- **Live auto-refresh: WORKING.** The device list re-polls `/api/devices` every 20 s
  (paused while the tab is hidden; refreshes on becoming visible), clearing the
  original complaint that the list only updated on reload.
- **Idle values: LIVE AND WORKING (verified end-to-end against the live boxes).**
  Real `idleSeconds` arrive from MeshCentral and join onto SpaceWorker's own device
  rows — live proof: `fetchUserIdle -> {"Sc":35,"WilkSF9":0}` then
  `JOIN -> 2/2 device rows got a real idle value`. Labels therefore render as
  `online · active now` / `online · idle 12 min` / `idle 3 hr`.
  *It was dark for most of the day* because **MeshCentral rejected Vantra's login
  token** (`cause:"noauth"`) — **pre-existing, not caused by C1**: the same unchanged
  token helper backs the mesh view-only route, which was equally broken. Root cause
  and the two-part fix are in `HOW_WE_MOVE_FAST.md` §6 ("MeshCentral login-token auth
  — RESOLVED"). One-line version: the token's `u` must be the **full userid**
  (`user//name`) and the env had a **bare** name.
- **Follow-on win (free): VERIFIED + CLOSED 2026-09-23.** That same fix repairs the
  pre-existing **mesh view-only session** flow (it had been failing for exactly the
  same reason). Proven by running Vantra's *real* functions against the live socket —
  deployed full userid → 3 nodes; a **bare** override → still 3 nodes (normalisation
  works); `findMeshNodeIdByHostname("Sc")` → `node//…`; `createViewOnlyShareLink()` →
  share URL; `GET <share url>` → **HTTP 200, 149135 bytes**. Nothing left to do here;
  do not re-open.
- **C1 follow-up (owner request, same day): one last-seen per screen.** The list row
  printed the same timestamp twice — the status chip (`offline · last seen 23 min
  ago`, `device-list.tsx`) and a dedicated "Last seen" column rendered *identically*
  right beside it; the console had the same duplication (`Summary` "Last seen" row vs
  the header chip). The **chip wins** (always visible, survives scrolling), so the
  duplicate column/row was removed in both files and **the freed list cell is now the
  reserved slot for the Ping button** (TASK_103 MISSING-1) so the row keeps its grid
  shape when that lands. `User activity` now reports idle only (idle exists only while
  connected) and shows `—` when offline instead of restating last-seen.
- **Visibility caveat:** idle renders only for devices SpaceWorker counts as
  `online`/`asleep` (its own heartbeat window). A device MeshCentral still sees as
  connected but SW marks `offline` shows `offline · last seen …` instead — that's by
  design, and it's why both of today's live devices still show `offline` labels while
  carrying idle values.
- **Unit is settled, don't re-investigate:** MeshCentral's `idletime` is in
  **seconds** (`agents/meshcore.js` → `win-deskutils.idle.getSecondsAllSessions()`,
  sampled ~every 5 min, most-recently-active session on the box). The shipped
  `MESHCENTRAL_IDLETIME_UNIT = "seconds"` is correct.


### Owner-confirmed decisions this pipeline encodes (do not re-litigate)

- **Direct-egress launch is PREMIUM ONLY** (owner 2026-10).
- **Clone records are kept** (audit value) and users can delete their own;
  **inactive records purge after 30 days** (`AdminSetting.clonePurgeAfterDays=30`).
  Only the *staging material* (encrypted capture) is deleted at revoke/expiry.
- **Hosted PCs are POOLED** (not one-per-user) — `AdminSetting.hostedPoolSize`,
  admin-set like every other RAM consumer (CROSS-TRACK RULE 7).
- **Manual actions never need approval**; approvals are for agent-initiated
  requests only (owner rule).
- **Session TTL defaults**: 60 min idle / 8 h hard cap — exposed as
  `AdminSetting.cloneIdleTtlMinutes` / `cloneHardTtlMinutes`, not hardwired.
- The clone **engine + MT-1 scripts already exist** (merged, `be88e29`); this
  pipeline is orchestration + schema + UI, not new device engineering.

---

## Owner runbook (per bit, after the agent commits)

1. Read the agent's diff — confirm it stayed inside the declared file list.
2. `npx tsc --noEmit` in the touched repo(s); `npm run build` locally.
3. For a migration bit: back up `.env` + DB, `prisma migrate deploy`,
   `prisma generate`.
4. Deploy per `HOW_WE_MOVE_FAST.md` §2 (`rsync --files-from … --exclude='.env'`,
   **with `-r`**, then build as the service user, then restart).
5. Live-verify (curl the route, check the journal, run the task's acceptance
   list). Only then flip the status line here.

## Status log

- 2026-10-02 — pipeline created; C1–C3, G1, B1–B6 registered above.
- 2026-09-23 — **C1 verified + DEPLOYED** (Vantra `0424b7b`, SpaceWorker `589292f`,
  verify-fix `71853dd`). Live refresh works; idle was initially dark on a
  pre-existing MeshCentral `noauth` outage.
- 2026-09-23 — **`noauth` ROOT-CAUSED + FIXED; C1 idle now fully live.** The token's
  `u` must be the full MeshCentral userid (`user//name`); the env had a bare name (the
  key itself was correct — verified byte-identical to MeshCentral's
  `LoginCookieEncryptionKey`). Two-part fix: `/opt/vantra/.env`
  `MESH_LOGIN_USER=user//vantra-service___4` (snapshot
  `/root/vantra.env.bak-t106fix-*`) **and** `makeLoginToken()` now normalises a bare
  name (Vantra `8296f47`, rebuilt + redeployed, build `EXIT:0`). Verified end-to-end
  live: `fetchUserIdle -> {"Sc":35,"WilkSF9":0}` and `JOIN -> 2/2 device rows got a
  real idle value`. **Bonus:** the pre-existing **mesh view-only session** flow is
  repaired by the same fix — **verified + closed 2026-09-23** (real
  `findMeshNodeIdByHostname` + `createViewOnlyShareLink` against the live socket:
  share URL minted, `GET` → HTTP 200 / 149135 bytes, and a bare-username override
  still authenticates). Full trail in `HOW_WE_MOVE_FAST.md` §6.
- 2026-09-23 — **C1-fu (owner request): one last-seen per screen.** Removed the
  duplicate last-seen rendering in BOTH surfaces (list column beside the status chip;
  console Summary row below the header chip). Chip wins; the freed list cell is the
  reserved slot for Ping (C2/MISSING-1). `User activity` reports idle only, `—` when
  offline.
- 2026-09-23 — **B1 DEPLOYED + VERIFIED.** Branch `agent/task-107-clone-schema`
  (`399a804`) merged to `main` as `7f27457`. DB backed up first
  (`/root/spaceworker-db.bak-t107.sql`), `prisma migrate deploy` → *all migrations
  applied*, `generate` → build (`trmm`, 0 errors) → restart. Live checks: migrate
  status **up to date**; 3 tables + 14 indexes (incl. both new sweep indexes) present;
  9 `AdminSetting` clone columns with defaults exactly matching
  `CLONE_SETTING_DEFAULTS`; `GET /api/admin/clone-limits` **403 unauth**, **full payload
  with a real admin session**; `PATCH {"maxConcurrent":3}` persisted then restored;
  `0` / unknown key / non-int all **400**; `/admin` 200 with the new block in the built
  chunk. Acceptance #2 (the shadow-DB test the agent couldn't run) satisfied against the
  **live** DB instead: drift filtered to clone objects = **none**.
- 2026-09-23 — **B2 DEPLOYED + VERIFIED.** `spaceworker 68c6586` + `vantra b7b42e4`
  merged to `main` and deployed (`.env` snapshotted, rsync `--exclude='.env'`, rebuild
  as the service user, restart). Both services active, both sites 200. All **7**
  clone/relay routes present; Vantra's bundle contains the command layer (7 compiled
  files). Boundaries proven live: invalid secret → **401 ×7**; valid secret + unknown
  agent → **404**; valid secret + real sw-linked agent → guard passes (route moved to
  its own zod check, 400 for a missing `cloneId`); offline device → **503** "This
  device is currently offline." Zero new 500s/errors in the journal; deployed
  `lib/clone-transport.ts` hash matches the commit. **Bug found + fixed:** the shared
  tenant guard let `getAgentDetail`'s `TRMM 404` throw escape, so every `sw-` route
  answered **500 instead of 404** for an unknown agent (contract violation + journal
  noise) — fixed in `23f9919`, verified 500→404. Two findings carried to B3/B4: agent
  RPC can take **~62 s** (client timeouts must exceed 60 s), and `clone-transport.ts`
  is intentionally absent from the SW build until B3/B4 import it. Remaining
  owner-only acceptance: real device capture/launch (needs the device online).
- 2026-09-23 — **OOB-1 filed (`TASK_113`) from B1's live drift check.** The 87-line drift
  is **entirely pre-existing Task-92** and contains **zero** clone references — B1 is
  clean. Real mechanism (corrected after reading `pg_constraint`): the FKs exist with the
  **same names** but the **wrong delete actions** — **13 × DB `CASCADE` where the
  datamodel declares `RESTRICT`**, **1 reversed** (`DeliverabilityCheck_seedMailboxId_fkey`
  DB RESTRICT / schema SET NULL), plus one index-name drift
  (`…relationType_k` → `…relationTy_key`). So the DB silently cascades device/audit
  deletes — the exact failure RULE 5 exists to prevent. Verified behaviourally inert
  today (no app code deletes a `Device`/`User`). Fix = Prisma's own diff output as an
  additive migration; owner applies.
  Also during this deploy: fixed the stale "build from `/opt/spaceworker/app`" line
  in `HOW_WE_MOVE_FAST.md` §1, recorded the **Vantra builds as `vantra`, not `trmm`**
  `.next`-ownership trap (§6), and wrote up the MeshCentral `noauth` root-cause trail
  (§6) so no future agent re-investigates it.


- 2026-09-24 — **B3 DEPLOYED + VERIFIED.** `agent/task-109-clone-orchestrator`
  fast-forwarded into `main` (`9e09145`, pushed; code-only bit → no migration).
  `rsync --files-from … --exclude='.env'` of `lib/clone.ts` + `lib/devices.ts`
  (`md5` on the box matches local byte-for-byte), built as `trmm` from
  `/opt/spaceworker` (`✓ Compiled successfully`, exit 0), service restarted, active,
  landing/login 200, zero new journal errors. `lib_clone_ts_*.js` is present in
  `.next/server/chunks` — the orchestrator is genuinely in the shipped bundle, and it
  pulls in `clone-transport.ts`, **closing B2's "intentionally absent from the SW
  build" note**. Acceptance ran as a **disposable live harness** (temp user + devices +
  relay + clone-host cap; every row deleted, residue re-checked to zero — CloneJob /
  RelayHealth / HostedBrowserSession 0/0/0, users back to 10, no leftover audits):
  **57/57 PASS** — illegal transitions throw, terminals are terminal (`deleted` is a
  tombstone the table never returns), 6/6 refusals audited with **no** `CloneJob`
  created, **panic through the real `POST /api/devices/panic` route** revokes the clone
  (`clonesRevoked:1`, terminal audit + `purgeAfter` + per-device `DeviceAudit`),
  **relay fails closed before capture** (`relay_unreachable: vantra_404: Device not
  found.` with zero capture jobs and no session row), in-flight marker re-entry →
  `interrupted_capturing` (step not re-executed), unknown `pending` never coerced,
  `deleteClone` terminal-only + owner-scoped, and no secret-looking material on any
  row. Remaining owner-only: real capture/launch against a physical Windows device
  (TASK_110 supplies the routes that will drive it).
- 2026-09-24 — **B4 DEPLOYED + VERIFIED.** `agent/task-110-clone-api`
  fast-forwarded into `main` (`75c789d`, pushed; code-only bit → no migration).
  `rsync --files-from … --exclude='.env'` of the 5 route files (`md5` on the box
  matches local byte-for-byte), built as `trmm` from `/opt/spaceworker`
  (`✓ Compiled successfully`, all 5 route slots in the build output), service
  restarted, active, landing/login 200, zero new journal errors. Acceptance ran
  as a **disposable live harness** (temp users + devices + relay + clone-host
  cap + assistant grant; every row deleted, residue re-checked to zero —
  CloneJob / User / Device / RelayHealth 0/0/0/0): **20/20 PASS** — bad
  egress/browser/role/status → 400 JSON; no entitlement → 403 with zero
  CloneJob; unowned device → 404; relay + pool → 201; cross-user
  GET/revoke/advance/session → 404 ×4; owner GET 200; history lists row;
  pre-launch session 404; DELETE live → 409 `clone_not_terminal`; revoke 200 +
  idempotent; DELETE terminal 200; `deleted` filtered from history. Remaining
  owner-only: `direct`-without-premium 403 copy, 202 queue copy, real device
  capture/launch.


- 2026-09-24 — **B6 DEPLOYED + VERIFIED.** `agent/task-112-clone-sweep` fast-forwarded into `main` (`c47f4b8`, pushed; code-only bit → no migration). `rsync --files-from … --exclude='.env'` of the 4 files (`app/api/internal/clone-sweep/route.ts`, `lib/clone-sweep.ts`, `deploy/clone-sweep.service`, `deploy/clone-sweep.timer`; `md5` on the box matches local byte-for-byte), local `npm run build` green (incl. `ƒ /api/internal/clone-sweep`), built as `trmm` from `/opt/spaceworker` (`✓ Compiled successfully`, clone-sweep slot in the build output), service restarted, active, landing/login 200, zero new journal errors. Acceptance ran as a **disposable live harness** (temp user + devices + jobs + relay + session; every row deleted, residue re-checked to zero — CloneJob / RelayHealth / HostedBrowserSession / e2e-users 0/0/0/0, harness script deleted from both checkouts): **13/13 PASS** — idle-TTL past-due `active` → `expired_idle` with `purgeAfter` stamp + `expired` audit; terminal `stagingRef` with no cloneId/device cleared + counted; staging second run no-op; relay-down probe flips `up`→`down` with `consecutiveFailures` 0→1; 31-day terminal + session purged/detached; 31-day `active` kept; purge second run no-op. Route: unauth → 401, bearer → 200 counts `{ expired, relaysChecked, stagingDeleted, purged }`, double-run no-op. `clone-sweep.timer` installed from `deploy/` (token substituted server-side via sed, never printed), `enabled` + `active`, service `exit 0`; `journalctl -u clone-sweep` shows counts JSON and the app log shows counts-only lines. Note: the installed unit files carry the live bearer (same as the older `automations-sweep.service`, which also embeds its token) — don't paste raw `systemctl status` output. Remaining owner-only: real device capture/launch teardown path (harness covered the no-pointer + down-relay branches only).

- 2026-09-24 — **B5 DEPLOYED + VERIFIED.** `agent/task-111-clone-ui` fast-forwarded into `main` (`4d2f6ca`, pushed; code-only UI bit, no migration). `rsync --files-from … --exclude='.env'` of the 3 files (`app/clone/[cloneId]/page.tsx`, `components/clone-session-view.tsx`, `components/device-console.tsx`; `md5` on the box matches local byte-for-byte), local `npm run build` green (incl. `ƒ /clone/[cloneId]`), built as `trmm` from `/opt/spaceworker` (`✓ Compiled successfully`, `/clone/[cloneId]` + all 5 clone API slots in the build output), service restarted, active, landing/login 200, zero new journal errors (the one `exit-code` line is the normal restart stop, exit 143). Live checks: unauth `GET /api/clones/:id` → 401 JSON; `/clone/:id` renders 200 with `Cloned browser` copy and no dashboard chrome; `Browser clone` / `Waiting for your PC` copy proven inside the shipped static chunks; local `tsc --noEmit` clean. Remaining owner-only: real browser render + click-through (empty state → start → step progression → premium-locked direct → relay-down explainer → new-tab open → revoke/delete) with a physical Windows device.

- 2026-09-25 — **B9 RECORDED (bit registered, not started).** Owner asked whether the 2026-09-25 POC
  means *"the agent can stream the session live"*. Precise answer, because half of it is proven
  and half is not.

  **PROVEN — the delivery half.** On two throwaway Neko containers on the VPS, with a disposable
  login site only, nothing touching `Sc`'s real Chrome or `WilkSF9`: CDP capture **in-process**
  (`export --domain` → `cookies_total=1 cookies_matched=1`, plaintext — no disk read and no
  decryption, which is exactly how it dodges F10/F11/F12); clone **isolation** (`cookies_total=0`
  for the target domain before injection); CDP `Storage.setCookies` injection
  (`setCookies=1 verified=1 opened=…`); and the **clone's OWN browser** then carried the cookie to
  the server — `[server] / hit, cookie present=true match=true` — driven by a script, so an
  **agent** can observe the result, not merely a human.

  **NOT PROVEN — and therefore the actual new build:** capture from a **real Windows Chrome**. The
  POC's source was a container we could attach CDP to, which is precisely what F12 forbids on a
  customer's browser. The only surviving route is `chrome.cookies.getAll()` **inside** the
  extension (Part B).

  **So B9 = Part A + Part B**, with the wire contract frozen in the task's **B9-3** so neither side
  blocks the other: extension capture (Part B, **Cline**) → 1 MiB-chunked native message →
  `POST /api/internal/clone-live-capture` (audit takes **counts only, never a cookie value**) →
  CDP inject into the running clone over a **host-loopback-only** per-session CDP port (the
  `swfwd` forwarder TASK_117 already scoped). `fresh`/route 3 stays the **default and
  byte-for-byte unchanged**; `live` is opt-in; a `live` job that captures **0** cookies
  **refuses with a named reason** and never silently degrades to `fresh`. Two owner questions are
  open in the task (Q1 capture scope / Q2 missing-extension detection). No code changed, nothing
  deployed, nothing built yet.

