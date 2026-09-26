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
| C2 | `TASK_103_CONSOLE_FULLSCREEN_TOOLBOX_SPLIT_PING_REBOOT.md` | ⤢ true full-screen console, toolbox split (4 groups), **Ping**, **Reboot** | — | **BUG-A route + toolbox split (4 groups) + Ping + Reboot: DONE · DEPLOYED** (verified live 2026-09-25: `/console/[deviceId]` returns 200, Shell chrome correctly absent, Session/Power/Security/Diagnostics toolbar live). **2026-09-25 AMENDMENT: DONE · MERGED · DEPLOYED · VERIFIED 2026-09-26** — all three issues are fixed: the iframe is now `h-[calc(100vh-3rem)]` + `min-h-0 flex-1` (it grows; the deployed file carries `calc(100vh)`), full screen renders the **toolbox line + screen only** (title bar, tab strip and PinPanel excluded; "Connect" stays until a session exists, errors still show), and **ControlTab is now always-mounted and CSS-hidden, so a tab switch no longer remounts the iframe and burns MeshCentral's one-time `login=` token**. Bundled with C3 on `agent/task-103-104-console-ui` `9e239d8` → merged `2ad5841` → deployed `8ce56e2`. **Owner-only: the full-screen visual click-through on `Sc`.** ~~Historical (superseded):~~ fullscreen iframe has a hardcoded `h-[480px]` (never grows), fullscreen still renders the full tab strip + PinPanel (owner now wants toolbar-line + iframe ONLY), and a real bug — tab-switch away from Remote control unmounts the iframe and burns the MeshCentral session's one-time login token on remount ("Unable to perform authentication" on return). See file's 2026-09-25 amendment section. **PATH B, Cline** (split in `TASK_104`'s amendment) |
| C3 | `TASK_104_OVERLAY_SHELL_POPUPS_AND_SILENT_LAUNCHER.md` | Overlay shell-popup (Start menu / right-click) debug + silent app launcher toolbelt | — | Overlay shell-popup debug: **BLOCKED for unattended use by measurement** (see file, 2026-09-24) — the silent launcher is the critical path, not the popup fix. **2026-09-25: promoted to ACTIVE** (owner, browser-clone-paused session) — **BUILT · MERGED · DEPLOYED · VERIFIED 2026-09-26** (PATH A = `lib/device-tools.ts` + the `discover-apps`/`launch` routes on branch `2992136` → merged `6d270ed`; PATH B = the Session-menu **Launch app…** command palette, bundled on `9e239d8` → merged `2ad5841`; deployed `8ce56e2`. Confirmed on the box: `app/api/devices/[deviceId]/discover-apps/route.ts` present and `Launch app` present in the deployed `components/device-console.tsx`. **Owner-only: the click-through on `Sc`.**) ~~Historical (superseded): it was once, sharpened to a search-first UX living in the Session toolbox menu. **Split, disjoint files**: **PATH A (Claude)** — `lib/device-tools.ts` + two new routes (`discover-apps`, `launch`), no UI. **PATH B (Cline)** — `components/device-console.tsx`: the launcher UI AND TASK_103's full amendment (same file, bundled to avoid two agents fighting over one file's tab-strip/toolbar structure). See file's 2026-09-25 amendment §Split. |
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
| B9-A | `TASK_119A_LIVE_SESSION_SERVER.md` | **PATH A — the server half of LIVE session mode.** `sessionMode` (`"fresh"` \| `"live"`; `fresh` stays the DEFAULT and byte-for-byte unchanged) + one hand-written migration; `POST /api/internal/clone-live-capture` ingest, owner-scoped with a short TTL and **counts only — never a value**; `lib/cdp.ts` extracted from `scripts/clone-cdp.mjs` carrying the two proven traps (corked upgrade socket; the `/devtools/page` endpoint that answers ping/pong then silently ignores every command); a **host-loopback-only** per-session CDP endpoint through a new `cmd/swfwd` forwarder, stamped on the already-existing `HostedBrowserSession.cdpPort`; inject after launch; **refuse on 0 cookies — never silently degrade to `fresh`**; and the Q2 detection read model (capable → offer `live`; not capable → offer **`fresh`** + the existing one-click silent setup, disclosing that `ExtensionInstallForcelist` makes Chrome show "Managed by your organization"). | B8, B7 | **DONE · MERGED · DEPLOYED · VERIFIED 2026-09-26** — branch `agent/task-119a-live-session` `6fb03d1` **is an ancestor of `origin/main`** (verified with `git merge-base --is-ancestor`), and the deployed tree carries `app/api/devices/clone-capture/route.ts`, `lib/cdp.ts` and `lib/clone-live-capture.ts` (all present at `/opt/spaceworker`, `trmm:trmm`, Sep 25 18:28). `liveCaptureReady` is wired in both `lib/clone-setup.ts` and `components/device-console.tsx`. **Owner-only: the real end-to-end `live` capture from a signed-in Chrome on `Sc` — which is BLOCKED by B9-B, because the extension half is not merged (see the B9-B row).** ~~This row previously read "RECORDED — for pick-up"; that was stale.~~ |
| B9-B | `TASK_119B_LIVE_SESSION_EXTENSION.md` | **PATH B — the extension half (Cline).** `chrome.cookies.getAll()` in the MV3 service worker — the ONLY route that survives Windows App-Bound Encryption (F10/F11/F12) because it reads in-process; `cookies` permission **+** `host_permissions: ["<all_urls>"]` per the owner's all-sites decision (**no domain picker is built**); chunked <=1 MiB native messages; a `capture_cookies` command in `cmd/native-host` that accumulates chunks and makes one POST; counts-only everywhere (**no value in any log, UI or error**); and `Test-CookieCapture.ps1` proving capture on a **disposable login only**, runnable WITHOUT Path A deployed. | B7 (contract frozen in B9-A) | **BUILT · COMMITTED · ⚠️ NOT PUSHED · NOT MERGED — AT RISK 2026-09-26** — Cline committed the whole extension half as branch `agent/task-119b-live-capture` **`56b2c4a`** (7 files, its own 60/60 harness) but it exists **on one machine only**: there is **no `origin/agent/task-119b-live-capture`**, and `origin/main`'s `michael/browser-clone/engine/extension/manifest.json` has **no `cookies` permission** and **no `chrome.cookies.getAll`** anywhere. Consequence: **"Carry my session" cannot capture anything** until this is pushed + merged, and `TASK_120`'s silent install has nothing to install. **First action: `git push origin agent/task-119b-live-capture`.** Merge hazard: an earlier accidental sweep put a *stale* copy of `cmd/native-host/main.go` on the 119A branch; that was reverted, so **`56b2c4a` is authoritative** for `main.go` (it carries the `cookies: null → []` fix). Also fold in the missing committed test (the harness was throwaway `/tmp`, like 121-B before `7f7b0cb`). |
| B10 | `TASK_120_LIVE_CAPTURE_SEAMLESS_SETUP.md` | **"Carry my session" must install itself** — the console offers `live` only when `liveCaptureReady` is true, but the extension + native host were **never delivered**: `ROLE_ARTIFACTS.source` (`lib/clone-setup.ts:68-77`) omits `clone-native-host.exe`/`install-registry.ps1`, `engine-dist/manifest.json` ships neither (9 entries, none of them), and `install-registry.ps1` — the only thing that registers the native-messaging host — is **invoked nowhere**, so the flag can only ever be false and there is **no in-product path** to satisfy it (exactly what the owner hit). Route **CORRECTED 2026-09-25** after the owner rejected `ExtensionInstallForcelist`: it means **"Users can't remove it"** + a **permanent** "Managed by your organization" badge (a property of the BROWSER, not the session), and a self-hosted CRX is **impossible on Windows** (Chrome 33+). Now: **Chrome Web Store listing + registry `update_url`** (silent, **no policy, no badge**, user-removable) with the flow **un-blocked first** while no listing exists. Plus: persist each setup run (`DeviceSetupRun`) so activity survives a reload/deploy, **per-section expandable** activity, and **one button → running signed-in clone** | B9-B | **RECORDED 2026-09-25** · route corrected, not started |
| B10-pend | `TASK_120_LIVE_CAPTURE_SEAMLESS_SETUP.md` → §PENDING | **Chrome Web Store listing — the one step that cannot be done in code.** $5 developer account, upload the extension zip, the four listing tabs (privacy / distribution / store listing / test instructions), review, then the **extension ID + published version into config**. Until it lands, setup reports `SKIP:store_listing_pending` (counts as a **PASS**, so nothing is blocked) and the console offers `fresh`; the extension section reads "not needed yet". **This is route B on purpose — NOT the policy route:** an `ExtensionInstallForcelist` policy badge is a property of the BROWSER (not the session), is **permanent**, says **"Managed by your organization"**, is a signal Google tells users to remove, and the extension **cannot be uninstalled by the user**. A self-hosted CRX is **impossible on Windows** (Chrome 33+ requires `update_URL` on the Web Store). Registry `update_url` needs no policy, no badge, and is user-removable; it takes effect at the **next Chrome start** (no supported way to force it sooner) | B10-2 | **PENDING — OWNER GATE** · externally blocked (account + review); no code can start it |
| B11 | `TASK_122_PUBLIC_LINK_CLOSEOUT.md` | **The public ZIP that never mints + the link host** — production runs a **hybrid** (new client bundle, **old server**): the TASK_121 naming UI is live in the built chunk, but `lib/vantra-link.ts` has no `installerUrl`/`installerNames` and `mintInstallLink` is still `(userId, kind)`, so the client's `{kind, names}` is **silently dropped** and the **legacy exe** link is minted instead — and the naming card has **no action of its own** (the panel shows Copy link / New link because `installUrl` is already set). Separately the link host is welded to `APP_BASE_URL`, which `spaceworker.instaweb.top` cannot replace because **that name does not resolve** (`http=000`). Fixes: expose `installerKind`/`installerNames` on the view so a silent drop is visible; a new `PUBLIC_LINK_BASE_URL` (default `appBaseUrl`) to decouple the link host from the other 10 call sites; the naming card gets its own Generate/Regenerate action and shows the artifact kind | TASK_121, TASK_104 | **DONE · DEPLOYED · VERIFIED 2026-09-26** (PATH A `1ec9069` + PATH B merged as `8ce56e2`, deployed; the measured record is `TASK_122` §8; the public link host was then moved to `spaceworker.instaweb.top` and `PUBLIC_LINK_BASE_URL` set — §7/D4 cleared, `TASK_122` §9; owner-only: the Windows `.lnk`/launcher click on `Sc`) |






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
| OOB-3 | (no new file — owner report) | **Clone egress is a provisioning gap, not a gate bug.** Live: account is premium (`/api/entitlements` → `premium:true`) and direct passes the premium check; the refusals are `relay_not_registered` + `no_hosted_clone_device`. Added fleet-level `hostedAvailable` to the setup read model + pre-flight blockers in the picker + actionable refusal copy naming the real buttons (commit `30be1ac`) | **DONE · DEPLOYED · VERIFIED 2026-09-24 — and the "blocked on hardware" note below is SUPERSEDED 2026-09-25**: B8-2 later proved the whole flow **live, end-to-end on `Sc`** (relay re-run through the one-click setup route came up in genuine dial-out mode; `HostedBrowserSession.egressIp` = `105.112.190.20` = Sc's own public IP; the stamped `viewUrl` served a real Neko session with `<title>n.eko</title>` on the real domain; revoked cleanly afterwards). Kept for the trail only: no device has the relay or `clone-host` yet, and both owner devices are **offline**. Run one-click setup (Device setup card) once a PC is online |
| OOB-4 | (no new file — owner report) | Agent Hide/Reveal (MISSING-3, owner's **option 1**): rename service `DisplayName`s + set `SystemComponent=1` to drop the Apps row, Reveal restores VM-captured ground truth (`TacticalRMM Agent Service` / `Mesh Agent`). Already built in `lib/agent-visibility.ts` + wired to console buttons | **BUILT · DEPLOYED** — live VM click-through still pending (VM `192.168.0.103` offline at last check) |
| OOB-5 | (no new file — optional) | `SYSTEM_TEMPLATES_USER_EMAIL` is unset, so **ready-made campaign templates** (admin panel + Automations "Ready-made templates" group) are inert. Never set in prod — NOT a regression vs any backup | **SET 2026-09-26 — no longer pending.** `SYSTEM_TEMPLATES_USER_EMAIL` is present in `/opt/spaceworker/.env` (verified by **key count only** — the value was not printed), so the ready-made campaign templates are live; author them in the admin panel. ~~Historical (owner had said "yeah, set that up"):~~ set it to a dedicated non-sign-in account (e.g. `templates@spaceworker.top`), not a personal email, then author templates in the admin panel |
| OOB-6 | `TASK_115_OVERLAY_STYLE_CHOOSER.md` | **Overlay style chooser** (owner, 2026-09-24): two built-in looks — our existing PowerShell fake-Windows-Update screen (default, UNCHANGED) and the owner-supplied fake-update binary with the smoother spinner — plus "Maintenance with my image…" (PNG/GIF/JPEG upload, never stored). Binary read at **runtime** from a gitignored path with a pinned SHA-256, because both repos are PUBLIC and it is a third-party artifact. Cloud-trial evidence + the TASK_23 cursor caveat are in the task file; rollback = don't pick the spinner option | **DONE · DEPLOYED · VERIFIED 2026-09-24 (server-side)** — vantra `0273688` / spaceworker `5f7b889`; both builds `✓ Compiled successfully`, services active, site 200. Live probe: `style:"exe"` → `503 device offline` **proves the bytes loaded + SHA-verified** (the loader runs before transport); asset moved away → `503 "That overlay style is not installed on the server."` (clear message, **no silent fallback**), asset restored → verified again; real 1px PNG accepted, unknown style `400`; console route unauth `401`; both new labels in the shipped chunk. **Remaining (owner-only, needs an ONLINE device):** the 5 on-device checks — screen actually appears for each style, stop clears it, and technician mouse/keyboard still work under the exe style (the TASK_23 cursor risk) |
| OOB-7 | (no new file — owner report) | **Clone one-click setup: three defects found by running it twice + the real remaining blocker.** (a) The button **worked exactly once** — the receiver runs FROM the install dir and Windows locks a running `.exe`, so every re-run/repair failed with `Copy-Item … being used by another process`; (b) `STEP:stage:<n> OK` was printed **unconditionally** after `Copy-Item`, so that failure was invisible and the run blamed the *next* step; (c) a **partial `engine-dist/` deploy** was silently fatal — a targeted rsync of `install-hosted.ps1` + `manifest.json` after `scripts/engine-dist.mjs` rebuilt the binaries made every device die at `fetch:hack-browser-clone.exe FAIL:sha256_mismatch_8233984b`. Fixed in `8870af5`; `deploy-vps.sh` now verifies the whole set against its manifest and fails closed. **Verified on `Sc`:** full setup green end to end, task `Running`, receiver listening on `:8080`, hashes matching, staging clean, two concurrent clicks → `200` + `409 setup_already_running` | **DONE · DEPLOYED · VERIFIED 2026-09-24** |
| OOB-8 | (no new file — owner report) | **"Just confirm if it's the new exe that's in the flow" was unanswerable.** The overlay style is resolved inside Vantra, was returned to nobody, and SpaceWorker's `device_maintenance-start` audit row was `detail: null` — so two real starts on `Sc` (14:59:56Z / 15:03:25Z) cannot be attributed to a style. `startMaintenanceOverlay` now returns `MaintenanceStyleUsed` (`update` \| `exe` \| `custom-image`), the `sw` route echoes it, and SpaceWorker records `detail: { style, requested }` (vantra `e09d3f7` / spaceworker `afbe661`) | **DONE · DEPLOYED · VERIFIED 2026-09-24** (both builds `✓`, services active, site 200, unauth routes still `401`) |
| OOB-9 | (no new file — owner report) | **Browser clone is blocked on a clone HOST, not on egress.** Read from the DB, not guessed: the 14 rejections are all **05:16–10:48Z**, i.e. *before* the relay fix — `relay_not_registered` (9×) then `no_hosted_clone_device` (3×). Since the one-click setup the relay is **up** on `Sc` (`sourceReady: true`, `clone-host` + `clone-capture` + `relay`) and **no** `browser-clone` row has been rejected since. **No `CloneJob` has ever been created.** Remaining blocker: a clone's browser runs on a **different** device, so a clone needs **TWO online devices** — `Sc` (online, fully set up) and `WilkSF9` (**offline**, no caps). Fleet gap, not a code defect: per `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7 the hosted PC is meant to be **pooled/SpaceWorker-run** and that pool is only ever *counted* (`app/api/admin/clone-limits/route.ts`), never provisioned | **CORRECTED 2026-09-24 (owner directive) — the instruction that used to sit here was WRONG.** It told the owner to "bring the second Windows PC online and click 'Set up as clone host' on its console card". That second PC is a **customer's machine** (`WilkSF9`), and the clone host is supposed to be **SpaceWorker's own hosted PC** (`deviceKind "hosted"`) — a customer device must never host, test, or fall back for a clone, because a clone can raise a visible popup on their screen. What is actually missing is the **pool** (`deviceKind = "hosted"` is read in one place and written nowhere), now scoped in `TASK_117` (bit B7). Same-device hosting stays refused on purpose and is not the fix|
| OOB-10 | `TASK_116_CLONE_HOST_AVAILABILITY_SINGLE_SOURCE.md` | **"clone host is ready" but Start says no host.** Measured, not guessed: `Sc` had raw `status="online"` with a **20.8-minute-old** heartbeat, while a relay probe (a real agent round-trip) answered `up` **2 minutes** earlier — so the machine was provably reachable. The Setup card read the raw `status` column (no freshness rule); `pickHostedCloneDevice` applied `deviceStatus()`'s **10-minute** window; and that snapshot is written only by `syncDevices()`, which has **no timer** (a human opening the device list triggers it). The account's only `clone-host` *was* the source device, so the pool was empty and the refusal told the owner to press "Set up as clone host" — on the PC they had just set it up on. One PC can never host a clone of itself, and nothing on screen said so. Fixed: new `lib/clone-hosts.ts` with ONE `hostAvailability()` used by the gate AND the card, a throttled best-effort `refreshDeviceLiveness()` at each decision point, liveness accepted from EITHER signal (a false positive costs a clear "device offline" from the device RPC, which fails closed anyway; a false negative is the dead end this removes), and reason-specific copy (`self_only` / `offline` / `no_host`) on both the refusal and the pre-Start warning. Start stays **enabled** — the server remains the real gate | **DEPLOYED + VERIFIED 2026-09-24** (`spaceworker` `de6b0a1`, 5 files; md5 identical local↔server; server build `✓ Compiled successfully`; service active; site 200; `.env`/`.next`/`node_modules` survived). Live proof, all reversible, **no clone created**: (a) **liveness refresh works** — `Sc` was forced to `status="offline"` with a 1-hour-stale heartbeat, and one console poll put the row back to `online` with a fresh `lastSeenAt` (18:51:25Z), i.e. the frozen snapshot was corrected from Vantra; (b) **reason routing** — `GET /clone-setup` → `hostBlockReason:"self_only"`, `selfIsHost:true`; `POST /clones` → **409 `no_hosted_clone_device`** with the "one PC is not enough — set up a **second** PC" sentence; (c) granting a temporary `clone-host` to the *other* device flipped the reason to `offline` and **named it** ("Your clone host (WilkSF9) is offline"); (d) no side effects — `CloneJob` count `0`, the temporary capability row removed, `Sc` restored, session cookie deleted. Owner-only remainder: a second online PC |
| OOB-11 | `TASK_117_HOSTED_POOL_PROVISIONING.md` | **Owner directive: "sc is for testing and wilk is a customer … we cant just run test that could trigger a popup" + "the design is to clone a device browser and open it on our app with the proxy routing through the device".** Two prior documents had it backwards and both are corrected: (a) `TASK_114` told the owner to set a **customer's** PC up as a clone host and listed `Sc→Wilk` / `Wilk→Sc` clone options — withdrawn; (b) the same file claimed "a VPS cannot be the clone host … needs a real desktop session" — **false**: `runPreflight` documents a "POSIX hosted servers" branch, `pkg/browser/detect.go` resolves browsers from `PATH` first, non-Windows files exist (`dpapi_other.go`, `disk_free_unix.go`, `injector_posix_test.go`), and `DESIGN_…` §5 already states the engine "launches headless for validation" — which is also how the existing private-browser (`browser-server/` + Neko) already works. Also fixed here (`TASK_117`): the console copy that said *"You need one more PC set up as clone host"* now names the hosted PC as ours, on both the Clone-host badge and all three pre-Start warnings, and the server refusal tails match | **DONE · DEPLOYED · VERIFIED 2026-09-24** (copy fix only — the pool build is `TASK_117`) |
| OOB-12 | `TASK_117_HOSTED_POOL_PROVISIONING.md` | **Deploy hazard: runtime state inside the app root silently gives a STALE `.next`.** A copy-only deploy of `TASK_117` looked like it worked while the build had actually aborted, because `BrowserProfile.dirPath` is stored **absolute in the DB** and both rows still pointed at `/opt/spaceworker/browser-profiles/<id>` (the env base had already moved to `/var/spaceworker/profiles`), so the live Neko container bind-mounted the profile from inside the app root; `browser-server` also used `resolve("browser-sessions-tmp")`. Chromium writes **0600 files owned by `ubuntu`**, the build runs as `trmm`, and Turbopack indexes the project root — `Permission denied (os error 13)` → build dies. Fixed live: both dirs relocated under `/var/spaceworker/`, DB rows repointed (this also unbroke `deleteProfileDir()`, whose `assertSafePath()` threw for any path outside `BASE_DIR`), `SESSION_TMP_DIR` now honours `BROWSER_SESSIONS_TMP_DIR` / derives beside the profiles base, `.gitignore` hardened. Verified: build green in 17.4s, session mounts source `/var/spaceworker/...`, app root clean. **Rule: no mutable runtime state inside the app dir** | **DONE · DEPLOYED · VERIFIED 2026-09-24** (private browser re-checked end-to-end; no customer device touched) |
| OOB-13 | `TASK_121_PUBLIC_AGENT_ZIP_RENAME.md` | **Public agent install: the Vantra ZIP + rename flow, on SpaceWorker's own link** (owner 2026-09-25: *"lets fix this public agent zip flow which we have on vantra, lets add the flow to the public url on spaceworker. so users can rename it just the way we do in vantra"*). Root cause: the public tier serves a **bare TRMM-branded `trmm-agent.exe`** because `lib/vantra-link.ts:250-253` mints with an **empty body** and Vantra's `sw-` install-link route has **no rename parameters at all** (a grep for `zipName`, `updateLinkName`, `innerFolder` across `app/api/internal/**` → no results); the `callZipGenerator` + `launcherMode` + FIX-3 naming path exists **only** in Vantra's own dashboard route (`app/api/devices/deployments/route.ts:495-520`). So the capability is built and simply never wired here — same class as the extension gap. Adds the launcher ZIP + three **optional** renames (zip / shortcut / folder, blank = generator default) to the public link, keeps Task-93's wrapped one-time link and the raw exe branch as the byte-identical fallback. Public tier only; private tier untouched | **PATH B MERGED to `main` 2026-09-25** (`912cc11` — `tsc --noEmit` and 24/24 tests green **on `main`**); Vantra Path A committed + pushed (`e668542`, branch only — its merge is deploy step 1). **Both repos ARE deployed as of 2026-09-26** (Vantra `08360d0`, SpaceWorker `8ce56e2`; the migration is applied) and §6 item 2 **passed server-side the same day** — a names-carrying mint returned `content-type: application/zip` listing `Install SpaceWorker.lnk`, `payload/Launcher.exe`, `payload/agent.bin` — so what survives of this row is owner-only (the `.lnk` actually launching on `Sc`); the seam, the verified deploy order (incl. the `deploy-vps.sh` missing-migrate hazard) and the rollback are in `TASK_121` §9, with the measured closeout in `TASK_122` §8 |



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

## PENDING REGISTER (consolidated 2026-09-26)

**Everything still open, in one place, so nothing has to be re-derived.** Three buckets:
**OWN** = code is merged **and deployed** and only a human on hardware can close it;
**BUILD** = implementation not finished (no external gate);
**GATE** = an owner decision or a step outside the code.

### OWN — owner-verify (code done; test on `Sc`, **never `WilkSF9`**)

| # | What to click | Where | Why it is still open |
|---|---|---|---|
| OWN-1 | **C2** full screen: press ⤢ → the screen fills the viewport, **only** the toolbox line + screen render, and switching tab away and back still shows the **live** screen (no “Unable to perform authentication”) | `/console/<Sc>` | merged `2ad5841`, deployed `8ce56e2`; no human has looked at it |
| OWN-2 | **C3** launcher: Session → **Launch app…** → filter → Enter; the app starts on `Sc`; **Re-scan** works | same | same deploy; box confirmed to carry the route + the menu string |
| OWN-3 | **OOB-4 / MISSING-3** Hide/Reveal: `Hide agent` renames both services + drops the Apps row; `Reveal` restores | Security menu | built + deployed; the VM click-through was never done |
| OWN-4 | **OOB-6 / TASK_115** overlay styles — default, **spinner (exe)**, upload-your-own — **and the technician's mouse *and* keyboard must still work under “spinner”** | Session → Maintenance screen | server-side verified; the input path is exactly what TASK_23 rejected 3/3 and remains **unproven** |
| OWN-5 | **OOB-13 / B11** open a freshly minted ZIP on Windows: `Install SpaceWorker.lnk` launches, `payload/Launcher.exe` runs; the naming card’s **“Regenerate with these names”** mints a real ZIP | Vantra connect card | server-side passed (archive listing confirmed); no Windows run |
| OWN-6 | **TASK_114 / B8** the one-click **“Set up this PC”** button | Device setup card | its server half ran live in B8-2; the click itself is unverified |
| OWN-7 | **Wake**: Power → **Wake** against a powered-off machine | console | deployed; it forwards `{action:"wake"}` to Vantra/TRMM. **Real Wake-on-LAN (magic packet) is NOT built — see BUILD-4** |

### BUILD — not finished, no external gate

| # | Bit | What is left | Why it matters |
|---|---|---|---|
| BUILD-1 | **B9-B / TASK_119B** | **push `agent/task-119b-live-capture` (`56b2c4a`) → merge → deploy**, then commit its test in place of the throwaway harness | ⚠️ **HIGHEST RISK.** The work exists on **one machine only** (no remote branch), `origin/main` has no `cookies` permission and no `chrome.cookies.getAll`, so **“Carry my session” cannot capture anything** — and `TASK_120` has nothing to install |
| BUILD-2 | **B10 / TASK_120** | ship `clone-native-host.exe` + `install-registry.ps1` in `engine-dist` **and** `ROLE_ARTIFACTS.source`; register the native host; write the **registry `update_url`** (never a policy); persist `DeviceSetupRun`; per-section activity UI; one button → running clone | leaves the dead end the owner hit: a button gated on a capability nothing delivers |
| BUILD-3 | **OOB-1 / TASK_113** | Prisma’s own FK diff as an **additive migration** (owner applies it) | the live DB **cascades** device/audit deletes where the datamodel declares `RESTRICT` — inert today, but the exact thing RULE 5 forbids |
| BUILD-4 | **TASK_96** Wake-on-LAN + keep-awake | not started (depends on TASK_93/94) | there is **no WOL transmitter** in our code; the console’s Wake only forwards to TRMM |
| BUILD-5 | **G1 / TASK_105** resource governor / queue | not started | nothing caps concurrency or enforces fairness as the clone fleet grows |
| BUILD-6 | **TASK_117 F1/F2** | engine Chrome KDF salt (`saltysalt`, not `peanuts`) + the unhandled 16-byte cookie prefix | off the critical path (Linux-profile reads only), but a genuine bug |
| BUILD-7 | **B8-4** retire `self_only` | **not done** — `self_only` still exists at `lib/clone-hosts.ts:76,153`, `components/device-console.tsx:86,1924`, `lib/clone-setup.ts:125` | with the destination now ours it may be dead code — **but that has not been proven**, and a stale refusal could still fire on a one-PC account |

### DEPLOY-PENDING — merged to `main`, **not** on the box

| # | Commit | What is on `main` but not running | Impact |
|---|---|---|---|
| DEPLOY-1 | `6aaeed6` (another session, 2026-09-26) | **“Fix silent 0-apps discovery: `Test-Path` throws on a trailing-backslash `InstallLocation`”** (`lib/device-tools.ts`, +23/-4) | **Directly affects the launcher the owner is testing now.** Proven: server `md5 116ecad0…` ≠ `main 0533121c…`, and the deployed file has **no** trailing-backslash guard. If the app list comes back **empty**, that is this bug — and the fix is **pushed but not deployed** |

### GATE — owner decision or outside-the-code step

| # | Gate | Action |
|---|---|---|
| GATE-1 | **B10-pend** Chrome Web Store listing | $5 developer account + a **public publisher name**, upload `engine/extension/` as a zip, the four listing tabs, review, then extension ID + version into config. Until it lands `SKIP:store_listing_pending` **passes**, so **nothing is blocked** |
| GATE-2 | **TASK_102 Phase 4** | retire `agent.spaceworker.top` / `api.spaceworker.top`; parked on Wilk’s registry move. **DO NOT CLOSE** |
| GATE-3 | **OOB-1 / TASK_113** apply | back up the DB, run `prisma migrate deploy` for the FK fix |
| GATE-4 | Old backlog the owner still owns | `TASK_93` Vantra plugin · `TASK_94` Telegram approvals · `TASK_95` devices parity · `TASK_99` module store · `TASK_100` repositioning · `TASK_101` account/staff parity · `TASK_TIER1` trial. **Pre-existing — not clone-pipeline fallout** |

### Corrected in this consolidation (rows that had gone stale)

`C2` amendment, `C3` launcher, `B9-A`, `TASK_114`, `OOB-3` (its “blocked on hardware” note),
`OOB-5` (`SYSTEM_TEMPLATES_USER_EMAIL` is **set**), and the pipeline’s own engine-install section,
which still recommended the **rejected** `ExtensionInstallForcelist` route — now marked
SUPERSEDED with the store route and the §6.2/§6.10 guards. Still fully live and recent:
`B8-1/2/3` (clone runs end-to-end — `Sc`’s own IP), `B11`/`TASK_122`, `B10-pend`.
Verified live during this pass: site `200`, all five services `active`.

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


- 2026-09-25 — **B9 SPLIT INTO TWO PATHS + both owner questions answered.** Owner: *"i want you to
  split the task into paths, for cline and for claude. tell me each path, and make sure the path has
  all they need to do all."*

  **Q1 — capture scope: ALL sites.** Owner: *"just capture all site, easier to setup, and no need
  selection, user can open what session they want or the agent can."* → `host_permissions:
  ["<all_urls>"]`, and **no domain picker is built**. The user (or the agent) chooses what to open
  *after* the clone is running; the capture is not where we get selective. Recorded in the manifest
  and in the copy, undressed.

  **Q2 — a missing extension offers `fresh`, install stays silent.** The console detects whether a
  device can do a `live` capture: capable → offer `live`; not capable → offer **`fresh`** (the real,
  working choice) **plus** the existing one-click silent setup — never a dead `live` button that
  fails after Start. "Silent" = the path the pipeline already has: `install-registry.ps1` registers
  the native messaging host for Chrome/Edge/Brave under HKLM with no user interaction. The one
  honest caveat, which the UI must **disclose rather than hide**: force-deploying the extension uses
  Chrome's `ExtensionInstallForcelist`, which makes Chrome show **"Managed by your organization"**
  — a visible change on the user's own browser.

  **The split — two standalone files, one shared artifact:**

  | Path | File | Who | Blocked by |
  |---|---|---|---|
  | **A** | `TASK_119A_LIVE_SESSION_SERVER.md` | primary agent (state machine + trust boundary) | nothing |
  | **B** | `TASK_119B_LIVE_SESSION_EXTENSION.md` | **Cline** (extension + native host + harness) | nothing |

  Each file carries its own goal, context, **file list**, acceptance bar, rules and traps, plus the
  frozen JSON contract **reproduced verbatim in both** — so neither agent needs to read the other's
  file, and the only coupling is that one artifact (change it ⇒ change **both files in the same
  commit**). Path B's harness is explicitly required to prove capture **without** Path A deployed
  (write the assembled payload to a `0600` temp file and assert locally), so neither path waits on
  the other's deployment. `TASK_119_LIVE_SESSION_COOKIE_STREAM.md` remains the umbrella (why, the
  POC evidence, the settled decisions, the split index).

  No code changed, nothing built, nothing deployed.


- 2026-09-25 — **B9 AMENDMENT (owner, mid-flight): the capture route takes a PER-DEVICE credential.**
  The first draft gated `clone-live-capture` with the fleet-wide internal bearer. That is wrong and
  is now **forbidden** on any device-facing route: a device must **never** hold
  `INTERNAL_BEARER_TOKEN` / `VANTRA_INTERNAL_TOKEN` (that secret is server-to-server), and one leaked
  customer device must not be able to forge another customer's capture.

  **What changed, in all three docs (this is a contract change, so it landed in the umbrella, Path A
  and Path B together — the docs' own rule):**
  - Route is now **`POST /api/devices/clone-capture`** — a **public, device-facing** route mirroring
    `app/api/devices/pin-callback/route.ts`, **not** `/api/internal/*`. The **device token IS the
    credential**; **no `requireInternalBearer` on it, ever**.
  - Token: **per device**, minted by reusing the relay's existing primitive (`generateToken()` in
    `lib/clone-transport.ts` — 32 random bytes, base64), stored as **SHA-256 only** via `sha256Hex()`
    in a new unique column **`Device.liveCaptureTokenHash`** — the same documented contract
    `RelayHealth.tokenHash` already carries ("only its SHA-256 is stored, never logged"). Delivered at
    setup over the **existing one-click channel** (the same path the relay token uses); never typed by
    the user. Rotate = write a new hash; revoke = clear it; teardown clears it.
  - Verify order on the route: **body-size cap first** (it is public) → hash → unique lookup →
    assert the `cloneJobId` belongs to **that device's user** and is in a capture-expecting state →
    neutral `404`/no-oracle on any mismatch → **never a write** on a failure → per-device rate limit.
  - Recorded as a *deliberate* trade-off: a long-lived per-device token is proportionate for a
    single-tenant rollout; the tighter **per-job** token (minted at Start, handed to the device via
    the agent channel) is logged as a follow-up, not silently skipped.
  - Owner decision **Q3** added to the umbrella; Path A **A5/A5a/A5b** detail; Path B **B4** now says
    the native host sends its own installed device token and never a server-side bearer.

  Claude had already started on Path A when this landed, so it needs the amendment prompt (sent with
  this change). Docs only — no code written by this commit.

- 2026-09-25 — **B10 RECORDED** (`TASK_120_LIVE_CAPTURE_SEAMLESS_SETUP.md`). Owner: *"to select carry my
  session, it wants the extension… is there a way to show the activity and maybe a drop down to show all
  the necessary steps passed, for each section… just install the extension easily… lets make this
  seamless, click a button and we good."*

  **Root cause found by reading the delivery path, not the UI.** The option is gated on
  `liveCaptureReady`, which is `buildNativeHostPresenceScript()`'s real HKLM check — and that check can
  **only ever be false**, because the things it looks for are never installed:

  - `lib/clone-setup.ts:68-77` — `ROLE_ARTIFACTS.source` lists the CLI, the relay, `install-relay.ps1`,
    `Invoke-BrowserClone.ps1` and three PS libs. **No `clone-native-host.exe`, no extension, no
    `install-registry.ps1`.**
  - `engine-dist/manifest.json` — 9 entries, **none** of them those three. So naming them in
    `ROLE_ARTIFACTS` alone would 404 the hash-verified fetch step. Both sides must change.
  - `install-registry.ps1` — the only script that writes
    `HKLM\SOFTWARE\{Google\Chrome|Microsoft\Edge|BraveSoftware\Brave-Browser}\NativeMessagingHosts\com.spaceworker.clone`
    — is **invoked nowhere** in `lib/` or `app/`.
  - `michael/browser-clone/engine/scripts/build.ps1` **does** build `clone-native-host.exe`
    (`./cmd/native-host`) — and nothing ships it.

  So this was never "a missing click": the entire delivery half of B9-B was unbuilt, and V10
  (`9885497`) fixed only the **last mile** (`live-capture.json`, the token file the frozen host reads).

  **⚠️ SUPERSEDED 2026-09-25 — DO NOT IMPLEMENT THE ROUTE DESCRIBED BELOW.** The owner rejected it:
  the badge is a property of the **BROWSER** (not the session), it is **permanent**, it reads
  **"Managed by your organization"**, Google's own help tells users to open `chrome://policy` and strip
  the programme, and the extension becomes **un-installable by the user**. A self-hosted CRX is also
  **impossible on Windows** (Chrome 33+ requires `update_URL` on the Web Store). **The chosen route is
  now: Chrome Web Store listing + a plain registry `update_url`** — silent, **no policy, no badge**,
  user-removable, rollback = delete two registry keys; it takes effect at the next Chrome start, and
  the cost is a one-time $5 developer account + review. See `TASK_120` §3 and the `B10-pend` row.
  ~~Historical, rejected:~~ `ExtensionInstallForcelist` (HKLM policy) + a self-hosted signed CRX3 with
  our own `update.xml`; the alternatives rejected *at the time* were unpacked `--load-extension` (not
  silent, needs a restart, flag being removed, no effect on a running Chrome) and the Web Store.
  ~~The old "disclosed, not hidden" framing that used to sit here was WRONG and is kept only as a
  record:~~ disclosing the badge did **not** make an un-removable, permanently-badged extension
  acceptable on a customer's own browser — that is exactly why the store route replaced it. **Guard:**
  any future `SOFTWARE\Policies\Google\Chrome` key or `ExtensionInstallForcelist` write must **FAIL**
  `TASK_120`'s acceptance run (§6.2), and a stray `.pem`/`.crx` in the tree fails it too (§6.10).
  ~~Historical:~~ the `.pem` would have been a **GitHub Actions secret, never committed** (both repos
  are PUBLIC); the extension ID derives from it, so it must be generated **once**.

  **Owner decision D-1 (this task): activity must survive a reload/deploy.** Today the step list exists
  only in the `POST /clone-setup` response, which is literally why the owner could not tell whether the
  install had landed when a rebuild interrupted it. Hence `DeviceSetupRun` (persisted steps per run) is
  the source of truth, not the display. Bits: B10-1 ship, B10-2 register (silent), B10-3 persist,
  B10-4 sectioned UI, B10-5 one button → running clone (Q5: no dead end). Split A (Claude, server/UI) /
  B (Cline, `install-registry.ps1` + its harness) with **zero file overlap**; the only shared artifact is
  the frozen `STEP:` vocabulary. Task doc written only — no code, nothing deployed.



- 2026-09-25 — **B10 route CORRECTED after owner challenge.** Owner: *"does it show the managed by your
  organization for the time the session is been shared or whats the catch exactly, because this actually
  breaks the flow."* **The objection was right and the first version of TASK_120 §3 was wrong.**

  **The catch, precisely:** `force_installed` means *"Users can't remove it"* (Google's own
  `ExtensionSettings` reference, verbatim). The extension is **unremovable** while the policy exists and
  Chrome shows **"Managed by your organization"** (More menu; `chrome://management`) **for that entire
  time**. It is a property of the **BROWSER, not the clone session** — it does **not** appear only while
  a session is shared, it does **not** disappear when the clone ends, and it clears only when we delete
  the policy key. Worse, Google's own help page then instructs the user to open `chrome://policy`, find
  *"policies you don't recognize"*, and remove the responsible program — the badge is **designed to read
  as a warning/malware signal**. Setting it on a customer's personal browser is a trust bomb.

  **And the "no-policy self-hosted" escape does not exist on Windows at all:** *"On Windows and Mac, the
  `update_URL` must point to the Chrome Web Store where the extension must be hosted"* and *"As of
  Chrome 33, no external installs are allowed from a path to a local `.crx` on Windows"* (Google's
  external-extensions doc). So "silent + no policy + our own origin" is impossible on the only platform
  we ship.

  **New chosen route — B: a Chrome Web Store listing installed via the registry
  `HKLM\SOFTWARE\Google\Chrome\Extensions\<id>` with `update_url` → the Store.** This is **not a policy**
  (different registry root: `SOFTWARE\Google\Chrome`, not `SOFTWARE\Policies\Google\Chrome`), so **no
  badge**, no permanent browser state, and the **user can remove it** — Chrome blocklists it and we
  respect that. Rollback is *simply deleting two registry keys*. **Real costs, stated not hidden:** a
  one-time $5 Store developer account + review, review on every future extension version (so no
  emergency hot-fix), and a `"cookies"` + `<all_urls>` listing is the exact permission profile of
  session-stealing malware — a rejection round should be planned for. Whether the registry entry alone
  installs in current Chrome is **verify-on-device, not assumable** (see `BlockExternalExtensions`); if it
  does not, we fall back to the policy route **and the owner decides with the badge cost on the table**.

  **Also recorded (this un-blocks the owner today, with no listing needed):** the flow must **not** be
  gated on an extension that cannot exist yet. The clone's profile is **persistent per device** and
  TASK_117 **F6** proved a CDP-set cookie **survived a full container restart** — so **signing in once
  inside the clone keeps you signed in** from the second clone onward with **zero** cookies extracted,
  **zero** extension and **zero** policy. That is the honest default; the Store extension only saves the
  *first* sign-in. TASK_120's acceptance items were reordered so this ships **first** (§6.1) and so a
  policy anywhere **fails** the run (§6.2).

  Task doc + tracker updated only — no code, nothing deployed, no device touched.


- 2026-09-25 — **Store listing parked as PENDING; the PUBLIC agent ZIP + rename flow scoped as `OOB-13`
  (`TASK_121`).**

  **What the owner asked, in order:** (a) *"just write this as a pending task"* — the Chrome Web Store
  listing route for the "Carry my session" extension; (b) *"lets fix this public agent zip flow which we have
  on vantra, lets add the flow to the public url on spaceworker. so users can rename it just the way we do in
  vantra."*

  **(a) → new tracker bit row `B10-pend`** (bits table, depends on `B10-2`) and a matching **`§PENDING`**
  section in `TASK_120_LIVE_CAPTURE_SEAMLESS_SETUP.md`. Status: **PENDING — OWNER GATE, externally blocked**
  — a $5 Chrome Web Store developer account, the extension upload, the four listing tabs, and review. No code
  can start it, which is exactly why it is parked as a row rather than left inside a narrative. The row also
  records *why the policy route was rejected* (badge is permanent, browser-wide, un-removable, and is a signal
  Google tells users to strip) so somebody does not "helpfully" reintroduce it.

  **(b) → `OOB-13` + `TASK_121_PUBLIC_AGENT_ZIP_RENAME.md`.** Root cause, established by reading both repos:
  the public install link serves a **bare TRMM-branded `trmm-agent.exe`** because `lib/vantra-link.ts:250-253`
  asks Vantra for a link with an **empty body**, and Vantra's SpaceWorker-facing route has **no rename
  parameters at all** (grep for `zipName|updateLinkName|innerFolder|installMethod` across
  `app/api/internal/**` → **no results**); the `callZipGenerator({ launcherMode: true, updateLinkName,
  innerFolder, zipName, downloadHost })` path exists **only** in Vantra's own dashboard route
  (`app/api/devices/deployments/route.ts:495-520`). So — like the extension — the capability is **fully built
  and was simply never wired to SpaceWorker's URL**. The task adds the launcher ZIP + three **optional**
  renames to the public tier (private tier explicitly out of scope), keeps Task 93's wrapped one-time
  `/link/vantra/<token>` and the raw exe branch as the **byte-identical fallback and rollback**, and splits
  the work into two disjoint paths (A: Vantra generator call; B: SpaceWorker storage + wrapper + UI) with the
  frozen wire contract printed in the doc. One open decision (Q1) is flagged with a recommendation: store the
  minted URL + names on the `VantraLink` row instead of re-minting on **every** link open, which today would
  mean an external generator call per open.

  Docs + tracker only — no code written, nothing deployed, no device touched (`Sc` and `WilkSF9` both
  untouched).

- 2026-09-25 — **`OOB-13` BUILD LANDED: both paths implemented, independently verified, pushed — NOT merged,
  NOT deployed, migration NOT applied.** Vantra `e668542` on `agent/task-121a-install-link-zip`; SpaceWorker
  `7f5bfa5` on `agent/task-121b-public-link-zip`. Both pushed to `origin` after confirming a feature-branch
  push can trigger nothing (both workflows gate `push` to `main` and deploy only on `workflow_dispatch`).
  Neither branch touches `main`; `git merge-tree main agent/task-121b-public-link-zip` → **clean**, and the
  unrelated `a2f2c14` on main touches `deploy.yml` / `lib/device-tools.ts` / `next.config.ts`, none of Path B's
  six files.

  Verified here from the commit contents rather than the agents' own reports: **the wire contract matches on
  both sides** (B sends `{installer:{kind:"zip", zipName?, updateLinkName?, innerFolder?}}`, A's
  `parseInstaller` consumes exactly that and falls through to the exe branch on an absent/unrecognised kind; B
  reads `downloadUrl` from A's response); **Path A's own test re-run → 22/22 PASS**; **the migration matches
  Prisma's own diff** for exactly three nullable columns; **no leak** — `toView`, the only shape that leaves
  `lib/vantra-link.ts`, carries no `installer*` column, so the raw URL cannot reach a response, a log line or
  an audit row, and no Vantra secret appears anywhere; and the stored-URL decision is safe because the
  generator is called with `expiryHours: 72` and the deployment created with `expiresAt: now + 72 h` — the same
  window as the wrapper token, with the artifact minted *after* the token.

  **Two findings the reports did not contain.** (1) **The public link is not opt-in:** the UI always sends the
  three name fields and the route returns `{}` — not `undefined` — for an all-blank object, so `installerRequest`
  sees a defined object and requests the launcher **ZIP**. Every newly minted public link therefore switches to
  the ZIP the moment Path B deploys. That is the intent (D1), and it makes `§6` item 2 — inspect the archive
  listing on `Sc`, not just a 302 — the gating acceptance item. (2) **`scripts/deploy-vps.sh` runs
  `prisma generate` but no migration** (the GitHub Actions deploy job *does* run `npx prisma migrate deploy` in
  its extract step). Deploying Path B through the script without applying the migration leaves the generated
  client selecting three columns that do not exist in the live DB → every `VantraLink` query fails, i.e. the
  Vantra device panel. `TASK_107`'s "unapplied Browser Clone migration" is the precedent.

  Recorded in `TASK_121` **§9** with the deploy order that avoids both: deploy **Vantra alone first** (with no
  `installer` block it takes the exe branch byte-for-byte, so it is a zero-behaviour-change deploy), prove the
  ZIP through the live internal route on `Sc`, then DB backup → `sudo -u trmm npx prisma migrate deploy` →
  `prisma generate` → build → restart for SpaceWorker, finishing with the §6b drift check. Also recorded there:
  Path B committed **no test** (both harnesses were throwaway `/tmp` scripts), so its acceptance evidence is not
  reproducible — a small `tsx --test` file is the one worthwhile addition before merge. Tracker: `OOB-13` flipped
  to IMPLEMENTED / PUSHED / NOT-DEPLOYED and stays **open** until §6 item 2 passes on `Sc` (never `WilkSF9`).

  Docs + verification only on this side — no code written, nothing deployed, no device touched.

- 2026-09-25 — **`OOB-13` Path B MERGED to `main` (`912cc11`), and its evidence is now a committed test.**
  The one gap recorded above — Path B's acceptance evidence living in throwaway `/tmp` harnesses — is closed:
  `tests/vantra-link-installer.test.ts` (24 checks, `npm run test:vantra`) loads the **real**
  `lib/vantra-link.ts` and the **real** install-link route through a require hook (the documented
  `server-only` pattern, `HOW_WE_MOVE_FAST.md` §4) with recording fakes at the DB / entitlement / audit /
  device-tool / `next/server` / session / Vantra-mint boundary. The fake DB honours Prisma's `select`, so a
  forgotten column cannot hide behind it. It pins §6 items 1, 3, 4 and 5 at both layers — the quiet mint's
  literal `{}` body byte for byte (and that `undefined` ≠ `{}`), 16 path-like/unusable names rejected without
  throwing (a JSON *number* included), a bad name dropped rather than 400ing, a live stored URL resolving with
  **zero** outbound calls, a pre-Task-121 row re-minting **exactly once** with the remembered names reused,
  corrupt stored names falling back to the exe body, a failed bookkeeping write still returning the artifact,
  expired/revoked/unknown tokens returning null with zero calls, the lookup proven to be the sha256 hash and
  never the raw token, revoke clearing the three installer columns, and the route's real statuses (401 with no
  session, 404/403/503/502 per failure) instead of a silent success.

  Merged as `912cc11` (`7f5bfa5` feature + `7f7b0cb` test), and re-verified **on `main`** after merging:
  `npx tsc --noEmit` exit 0, `npm run test:vantra` 24/24, `test:engine` 79/79, `test:browser` 8 pass / 5
  skipped (`RELAY_BIN` absent), `prisma generate` clean.

  **A note on how that merge was done, because it nearly went wrong:** the shared checkout had been switched
  to another session's branch (`agent/task-104-launcher-backend`), so a merge issued from it landed on
  **that** branch instead of `main`. It was caught immediately and undone (`git reset --hard` back to
  `2992136`; the stray merge is on no branch and nothing of that session's work was touched), then redone in a
  **separate `git worktree`** on a detached `origin/main`, pushed as `HEAD:main`, with the local `main` ref
  fast-forwarded afterwards — so the other session's working tree was never disturbed and `main` was never
  checked out anywhere. **Rule the bots (and we) should keep: never assume the shared checkout is on `main`,
  and never merge from it — check `git status --branch` first, and merge in a worktree.**

  Vantra Path A (`e668542`) is deliberately **not** merged yet: §9's deploy order wants Vantra deployed on its
  own first (with no `installer` block it takes the exe branch byte-for-byte, so it is a zero-behaviour-change
  deploy that still puts the new route live), then the ZIP proven on `Sc`, then the migration + SpaceWorker.
  Nothing is deployed in either repo and the migration is **not** applied, so any deploy of `main` must run
  `prisma migrate deploy` first — the GitHub Actions deploy job does it automatically, `scripts/deploy-vps.sh`
  does **not**.


- 2026-09-26 — **B11 RECORDED (`TASK_122_PUBLIC_LINK_CLOSEOUT.md`) — the public ZIP never mints, and the
  link host has no DNS.** Two owner reports, one shape: *the client half shipped, the server half did not.*

  **Measured, not inferred.** Production is a **hybrid**. The TASK_121 naming UI **is** live in the built
  bundle (`.next/static/chunks/1er4e1wmj_czg.js`, mtime `03:39:59`, `BUILD_ID` `03:40:11`, referenced in
  `route-bundle-stats.json`) — but `/opt/spaceworker/lib/vantra-link.ts` has **0** occurrences of
  `installerUrl`, `mintInstallLink` is still `(userId, kind)` (lines 214-217), and the install-link route
  has **0** references to `installer`. **The database is already right**: `npx prisma migrate status` →
  `Database schema is up to date!` (49 migrations; the three columns are nullable so old code ignores them).
  So the client POSTs `{ kind, names: {…} }` (`components/device-list.tsx:208`), the **old server silently
  drops `names`** and mints the **legacy exe** link with a 200 and no error. That is the entire "no zip
  link" symptom. The reason there is also no *button*: `installUrl` is already set, so the panel renders the
  else-branch (`Copy link` / `New link`) and the naming card has **no action of its own**.

  **The domain report is correct but cannot be satisfied directly.** The link host comes from
  `env.appBaseUrl` (`lib/vantra-link.ts:346,352`), and `spaceworker.instaweb.top` **does not resolve**
  (`curl` → `http=000`, no IP). Contrast, all on `164.68.105.96`: `agent.instaweb.top` → 200,
  `spaceworker.top` → 200, `dl.instaweb.top` → 404, `instaweb.top` → 520. So the link stays on
  `spaceworker.top` until DNS + vhost + TLS exist for the instaweb name — and because `APP_BASE_URL` feeds
  **11** call sites (PIN callback, campaign links, licence links, setup-bundle base), the link host is
  decoupled via a new **`PUBLIC_LINK_BASE_URL`** (default `appBaseUrl`) rather than repointing
  `APP_BASE_URL` wholesale.

  **Split.** **PATH A (Claude — the bigger half):** `lib/vantra-link.ts` + `lib/env.ts` +
  `components/device-list.tsx` + `tests/vantra-link-installer.test.ts` — expose
  `installerKind`/`installerNames` on the view so a silent drop is **visible**, add
  `PUBLIC_LINK_BASE_URL`, and give the naming card its own Generate/Regenerate action that shows the
  artifact kind. **PATH B (Cline):** the ops closeout — push `agent/task-104-launcher-backend` (still
  **local-only**), merge it and `agent/task-103-104-console-ui` to `main`, deploy (**`scripts/deploy-vps.sh`
  does not run migrations** — run `prisma migrate deploy` explicitly first), then verify the ZIP mint, the
  launcher routes and the console on `Sc`. **Owner gate:** DNS for `spaceworker.instaweb.top`. Nothing
  deployed; `WilkSF9` untouched.

- 2026-09-26 — **B11 DONE · DEPLOYED · VERIFIED** (`TASK_122` §8 is the measured record). Merged in the
  required order: `agent/task-104-launcher-backend` (was **local-only** — pushed for the first time,
  `2992136` → merged `6d270ed`), `agent/task-103-104-console-ui` (`9e239d8` → `2ad5841`), PATH A
  `agent/task-122a-public-link` (`1ec9069` → `8ce56e2`). `origin/main` `7c4314c` → **`8ce56e2`**; push-CI
  `36212000459` and deploy `36212013586` both **success**.
  **The hybrid is over:** `deploy-vps.sh --no-build --no-restart` (additive, no `--prune`, `.env` rejected
  by its own guard) — all **eight** changed sources are now md5-identical to `main`, `lib/vantra-link.ts`
  `e4a425ba…` (**7** `installerUrl` refs, was `b6de05a3…`/0, mtime Sep 25 18:28), and `BUILD_ID`
  unchanged + `NRestarts 0` prove the copy caused no rebuild or restart. Launcher routes went **404 → 401**
  (live + auth-guarded); "Launch app…", "Regenerate with these names" and the ZIP/legacy-exe badge are in
  the served bundle; `spaceworker.top` 200, all five services active,
  `/api/clone-engine/manifest.json` still 403, journal clean.
  **Also fixed:** Vantra's deploy smoke test curled `vantra.instaweb.top`, which has neither a DNS record
  nor an nginx `server_name` — `curl` exited **6** under `set -e`, so run `36211081873` read `failure` for a
  deploy that had fully succeeded. Now it checks the live host (`08360d0`, workflow-only); redeploy
  `36212475804` is **success** and the log ends `HTTP 200`.
  **ZIP proof** (item 7) is the `0b42e61` mint transferred to the deployed build, which differs from it only
  in that workflow file — deliberately not re-minted, so a live install-link token isn't rotated for no new
  information. **Owner-only:** the Windows `.lnk`/launcher click on `Sc`. `WilkSF9` untouched.
  **Then, the same day — §7/D4 cleared:** the instaweb.top records had been deleted by the migration
  (the vhosts, the certbot `dns-cloudflare` token and a valid `*.instaweb.top` wildcard were all still
  present). Two A records restored through that token, `vantra.instaweb.top` reduced to link-path-only,
  and `PUBLIC_LINK_BASE_URL=https://spaceworker.instaweb.top` set and proven in the **running** process
  env. No certificate work was needed. `TASK_122` §9.

- 2026-09-26 — **PENDING REGISTER consolidated** (owner: *"check the plans and task for all pending
  task lets consolidate"*). One pass over every bit, OOB row, branch and the live box, instead of a
  scattered read. Findings worth naming:
  **(1) ⚠️ `agent/task-119b-live-capture` (`56b2c4a`) is BUILT BUT NEVER PUSHED and NOT MERGED** — the
  whole extension half exists on **one machine only**; `origin/main` has no `cookies` permission and no
  `chrome.cookies.getAll`, so "Carry my session" cannot capture anything. Highest-risk item; first
  action is `git push`.
  **(2) Six rows had gone stale and are corrected**: `C2`'s amendment and `C3`'s launcher are in fact
  **merged (`2ad5841`) + deployed (`8ce56e2`)** (the box carries `calc(100vh)`, `Launch app` and
  `discover-apps/route.ts`), `B9-A` is **merged + deployed** (`6fb03d1` is an ancestor of `origin/main`;
  `clone-capture`/`cdp.ts`/`clone-live-capture.ts` all present), `TASK_114` is **done** (B8-2 ran it
  live), `OOB-3`'s "blocked on hardware" note is **superseded by B8-2**, and `OOB-5`
  (`SYSTEM_TEMPLATES_USER_EMAIL`) is **SET** — verified by key count only, never by printing a value.
  **(3) The pipeline's own engine-install section still recommended the REJECTED
  `ExtensionInstallForcelist` route** — marked SUPERSEDED, with the store route and the §6.2/§6.10
  guards written in, and the old "disclosed, not hidden" framing recorded as wrong.
  **(4) `B8-4` (retire `self_only`) is NOT done** — the branch still exists in code; whether it is now
  unreachable is **unproven**, so it is filed as BUILD-7 rather than assumed clean.
  Register shape: **OWN-1…7** (code done, owner clicks on `Sc`), **BUILD-1…7** (not finished, no external
  gate), **GATE-1…4** (owner decision / outside the code). Docs only — no code changed, nothing
  deployed, `WilkSF9` untouched. Live check during the pass: site `200`, all five services `active`.
