# TASK 230 — Public Standalone on MeshCentral (untie public from Tactical)

## Owner ask (verbatim intent, 2026-10-19)
"plan to make this private and public alone. and if the public can be a standalone,
not to disturb each other, since the tactical requires reconfig." Public devices keep
dying (Tactical agent drops after reboot/move); moving public→private rewrites the live
agent's server URL and restarts it, killing the connection. `instaweb.top` must never
appear on private. Devices should stay public-on-top, never auto-move, and the user
moves to private at will from a stable base.

## Triaged root cause (box-verified 2026-10-19 — no guesswork)
- **MeshCentral is fully independent** of Tactical: `meshcentral: active`, `tacticalrmm`
  inactive (per-request only), own daemon on `127.0.0.1:3401`, public path HTTP 200.
- **MeshCentral natively provides** `runcommand`, `shell`, `devicepower`, `upload`,
  `download`, `devicemessage` (meshctrl.js capability probe) — i.e. terminal + power +
  file transfer with zero Tactical involvement. This IS the lightweight terminal-mode
  public RMM the owner asked to find.
- **Tactical piggybacks on this MeshCentral** (`MESH_SITE` in Tactical local_settings):
  every device carries TWO agents (MeshAgent + tacticalrmm); Tactical's remote-view rides
  on Mesh. The MeshAgent outlives the Tactical agent (box reboot → Mesh node `conn:1`
  while Tactical went stale) — **the Tactical agent is the fragile component that dies.**
- **The kill path:** moving public→private rewrites the live agent's BaseURL/ApiURL and
  force-restarts `tacticalrmm` (Vantra `device-auto-move.ts` / `device-move.ts`). If the
  private domain isn't reachable from the box at that instant, the agent strands offline.
  This is why agents "go dark" during the move.

## Findings — instaweb apex + private leaks (box-verified 2026-10-19)
1. **Apex `instaweb.top` 520 = no nginx server block.** A cert `instaweb.top` covers
   `*.instaweb.top` + apex, but there is **no `server_name instaweb.top;` vhost** — nginx
   falls through to the default_server and Cloudflare returns 520. All the real public
   hosts work (`agent.`, `mesh.`, `spaceworker.`, `dl.` are 200). **Fix = add an apex
   vhost that stands ALONE** (static parking response, or 301 → `https://www.instaweb.top`
   only if it exists). **MUST NOT redirect or link to spaceworker.top or any other
   property (owner rule: instaweb stands alone; no new domain needed).**
2. **Private agent/web talk leaks into instaweb (the disconnect suspect).**
   - `TRMM_API_BASE_URL=https://api.instaweb.top` → `lib/trmm.ts:3` server-side TRMM client
     base — a **public** domain used for ALL TRMM API talk (incl. private devices).
   - `MESH_WSS_URL=wss://mesh.instaweb.top` → `lib/env.ts:110` mesh websocket — the remote-
     view/screen stream goes over the **public** mesh host for every device. This is exactly
     the "still points at wss" issue the owner flagged; it likely feeds the disconnect/
     tiny-screen problem for private devices.
   - Correct pair already present: `TRMM_PRIVATE_API_BASE_URL=https://agent.broks.beauty`,
     `TRMM_PUBLIC_API_BASE_URL=https://agent.instaweb.top`.
3. **Today there is only ONE mesh.** MeshCentral runs a single default domain; public AND
   private devices all enroll into instance A (`mesh.instaweb.top`). Per-device mesh host is
   resolved by `app/api/internal/sw/devices/[agentId]/mesh-urls` + `MESH_WSS_URL` — both
   must become **instance-aware** (public→A, private→B) for the split to hold.

## Rejected alternatives (researched, with reason)
- **Beacon RMM** — Go single-binary, Cloudflare-native, but PUBLIC BETA / not shipped. Not
  production-safe today.
- **OpenRMM** — Python, "emerging"; monitoring only, remote/scripting planned. Too immature.
- **Second Tactical instance** — owner explicitly rejected; heavy (Python+Django), and the
  same reconfig dance. Highest ops burden.
- **Domain-hygiene-only (Option B as originally sketched)** — still shares ONE fragile
  Tactical agent across public+private; fixes naming leaks but not the agent-death class.
  SUPERSEDED by this design, which also unties the agent.

## Decisions LOCKED (owner, 2026-10-19)
1. **Two SEPARATE MeshCentral instances** — full independence, no shared process.
2. **Private instance on the same VPS**, separate port + data dir + cert (no new server).
3. **Move = install-verify-remove**, never in-place reconfigure.
4. **instaweb.top hygiene** — public links + public agent only; clean private-side leaks;
   fix or confirm-unused the apex 520.

## Target architecture (two MeshCentral instances)
```
PUBLIC   = MeshCentral-A (instaweb.top, existing instance) — MeshAgent ONLY. NO tacticalrmm.
           Terminal/shell/power via mesh runcommand. instaweb lives HERE + on public links.
PRIVATE  = MeshCentral-B (mesh.broks.beauty, NEW 2nd instance, :3402) + tacticalrmm
           (agent.broks.beauty). Both private; no instaweb anywhere.
MOVE TO PRIVATE = install Mesh-B agent -> verify connect; install private tactical agent ->
           verify check-in; THEN remove Mesh-A (public) agent. Device ends private-only,
           no instaweb. Nothing is reconfigured live.
```
Tactical stays single-backend but becomes private-only (public uses mesh only). This also
removes the "tactical 2-connection" block on public entirely.

## WORK SPLIT
### A. TASK AGENT — product code (both repos; NO box access, NO deploys)
1. **Public installer** — emit a MeshCentral-A agent ONLY (no tactical), bound to the
   public mesh host + a dedicated public device group. No Python, nothing to rewrite later.
2. **Hide command** (the one public automation, TASK_228) — route via MeshCentral-A
   `runcommand` for Mesh-only public devices instead of `runCommandNow` (TRMM). Keep the
   60–120s timing and the "offline/503 burns nothing" rule.
3. **Device list** — public (Mesh-only) devices sorted on top (extends 228); label
   Public/Private by which agent is present.
4. **Move to private — TWO mechanisms, both install-verify-remove, NO reconfig:**
   - **(a) Button (primary)** — "Move to private" on the public row triggers: install
     Mesh-B agent → verify connect; install private tactical agent → verify check-in;
     THEN remove Mesh-A (public) agent. Via new endpoints, not Vantra live-reconfig.
   - **(b) PowerShell snippet (manual fallback)** — generate a copyable PS command the user
     runs on the device that does the same private installs (the owner asked for a
     runnable command too). Same ordering; user pastes it if the button path is unavailable.
5. **Instance-aware mesh host** — `mesh-urls` route + `MESH_WSS_URL` resolution must return
   the RIGHT mesh host per device: public→`mesh.instaweb.top` (A), private→`mesh.broks.beauty`
   (B). Fixes private remote-view riding the public mesh today.
6. **Vantra move flow** — permanently disable auto-move + the live-reconfigure
   `device-move`/`device-auto-move` path for SW orgs; add private provisioning (Mesh-B agent
   + private tactical) behind the move; add internal endpoints for install/verify/remove.
7. **Tests** — installer shape, hide-via-mesh branch, move ordering (install before remove),
   per-device mesh host (public→A / private→B), public-on-top + no-auto-move pins.

### B. SENIOR/INFRA (me) — box + domains + verify (task agent MUST NOT touch)
1. Stand up **MeshCentral-B** — 2nd instance, own port (3402) + data dir + cert, private
   device group. Independent process from instance A.
2. **DNS** — create `mesh.broks.beauty` (and `api.broks.beauty` if needed) → box
   `164.68.105.96`. Currently NO_DNS. (cert `*.broks.beauty` already exists ✓)
3. **nginx + certbot** — vhost `mesh.broks.beauty` → instance B; repoint Tactical
   `MESH_SITE` to the private instance. **Add apex `instaweb.top` vhost = static parking
   page (own 200/404), standalone — MUST NOT redirect/link to spaceworker.top or any other
   property** (kills the 520; no new domain needed).
4. **instaweb hygiene (private scrub)** — rewrite Vantra `.env`:
   `MESH_WSS_URL` → `wss://mesh.broks.beauty`, `TRMM_API_BASE_URL` → private base
   (verify intended host — `api.broks.beauty` or the private agent base) so NO private
   talk touches instaweb. Keep `TRMM_PUBLIC_API_BASE_URL` + `PUBLIC_LINK_BASE_URL` +
   `HOSTING_PUBLIC_BASE_URL` on instaweb (public/links only). Restart Vantra after.
5. **Post-deploy verification** — BUILD_ID ×2; both mesh instances independent (kill one,
   other unaffected); apex instaweb returns its parked response (not 520); `grep instaweb` absent from all
   private `.env`/config; private remote-view resolves to `mesh.broks.beauty`; public 200;
   clean journals. Evidence + STEPS stamps.

## MUST NOT touch
- Schema/migrations (none needed — agent-presence is already derivable).
- Deploys (Senior Verification Agent's job after owner GO).
- The task agent must NOT ssh to the box or edit nginx/DNS/env/config.json — that is
  section B only.

## Gates
- `tsc --noEmit` 0 · eslint touched files 0 · full suite ≥ floor in prompt docs ·
  `CI=true npm run build` ✓ · move-sequence ordering test (install before remove) green.
- Regression pins: public on top · no auto-move · hide runs once while online and burns
  nothing on offline · private flows unchanged · `instaweb` absent from private config ·
  two mesh instances independent.

## Open items (flagged, not blocking this build)
- Recovery of the 4 stranded greenland devices + Wilk (both TRMM + Mesh dead → needs
  on-machine agent restart or reinstall). Living proof of the bug; scope separately.
- Whether the private tactical stays single-backend (private-only) or also splits later.

## SECTION B EXECUTION LOG (senior, 2026-10-19)
### Phase 1 — DONE (all verified externally)
- **B.4a `TRMM_API_BASE_URL` scrub DONE** — `https://api.instaweb.top` →
  `https://agent.broks.beauty` in `/opt/vantra/.env` (backup `.env.bak-t230`);
  parity-probed BEFORE restart (both `/api/v2/agents/` = 404, root = 200 — same TRMM
  backend via the mirrored vhost). Vantra restarted: `active`, **zero `-p err` entries**.
- **B.3 apex vhost DONE** — `/etc/nginx/sites-enabled/instaweb.top.conf` parked standalone
  (owner rule: NO link to spaceworker.top). `server_name instaweb.top www.instaweb.top;`
  (www added after initial TLS-cert race — cert `instaweb.top` covers `*.instaweb.top` ✓).
- **B.3b broks apex parked DONE** — `/etc/nginx/sites-enabled/broks.beauty.conf`
  `server_name broks.beauty www.broks.beauty;` wildcard cert, mirrors park page.
- **Owner DNS edits DONE + externally verified 200:** instaweb apex · www.instaweb.top ·
  broks.beauty · www.broks.beauty · `mesh.broks.beauty` → A `164.68.105.96` (grey).
  (One transient 520 on www.broks raced the DNS save; origin log proves CF IP `162.158.14.150`
  receiving 200 — stable 200 ×3 after.) **Apex 520 root cause was stale orange-cloud rows
  pointing at dead `172.232.x/172.234.x` IPs — fixed by owner in CF dashboard.**
- **B.4b `MESH_WSS_URL` deliberately HELD** — repointing it now would break remote-view
  for every device still enrolled in instance A. Lands WITH Mesh-B + task-agent
  instance-aware resolver (A.5), atomically.
### B2 RECON (2026-10-19, instance A layout)
- Unit: `meshcentral.service` → `ExecStart=/usr/bin/node node_modules/meshcentral`,
  `WorkingDirectory=/meshcentral`, **User/Group=trmm**, `NODE_ENV=production`,
  `Restart=always`. Node v24.20.0, MeshCentral **1.2.4**.
- **Ports: pid 51530 holds 3401(127.0.0.1) + 3402(0.0.0.0)** = instance A (confirms the
  earlier "A owns both" gotcha). **pid 51674 already holds `127.0.0.1:3403`** → planned
  Mesh-B port is TAKEN by an unidentified second process (identify before B2 build;
  pick next free port, e.g. 3404). pid 1706 holds `:4430` (unidentified — likely
  neko/viewer; not ours to touch).
- `/meshcentral/data` listing + `data/config.json` read came back EMPTY via this probe →
  data dir location must be re-confirmed (possible `--datafolder`/alt data path or probe
  artifact) before cloning. Certs on box: `broks.beauty-wildcard` ✓ + `instaweb.top` ✓.
  → RESOLVED: real data dir is `/meshcentral/meshcentral-data/` (v1.2.x name); config read ✓.
### B2 — DONE (2026-10-19, all verified)
- **pid 51674 on 3403 identified** = SpaceWorker's own `browser-capture/server.ts` (tsx),
  NOT mesh → Mesh-B built on **3404** (verified free). pid 1706 = instance A main process
  (`--launch` self-restart pattern), holds 3401/3402/4430.
- **Instance B built:** `/meshcentral-b/` (node_modules hardlinked from A — same v1.2.4),
  data `/meshcentral-b/meshcentral-data/config.json` — cert `mesh.broks.beauty`,
  port 3404, `tlsOffload 127.0.0.1`, `redirPort 801`, `newAccounts: true` (first
  account on B = admin, then flip false), **flat-file store** (deliberate: full
  process+data separation from A's postgres — part of the independence goal).
- **systemd unit `meshcentral-b.service`** — User=trmm, WorkingDirectory=/meshcentral-b,
  enabled + active. Journal: clean boot, certs generated, `v1.2.4 ... Production mode`.
- **nginx vhost** `/etc/nginx/sites-enabled/meshcentral-b.conf` — cloned from
  `meshcentral.conf`, diff = exactly 3 transforms (server_name → `mesh.broks.beauty`,
  cert → `broks.beauty-wildcard`, proxy → `127.0.0.1:3404`). Includes the TASK_211
  DeskControl-UNCHECKED sub_filter block (owner rule applies to B too).
- **External `https://mesh.broks.beauty/` = 200** (first probe returned 400 — boot race,
  B was still generating certs; stable **200 ×3** after). CSP proves instance B
  (`connect-src ... wss://mesh.broks.beauty`).
- **INDEPENDENCE PROOF:** restarted B while sampling A — A's pid **1706 untouched**
  (etime continuous, no restart), A still 200, **zero `-p err` entries** on both journals.
  B also 200 after its restart.
### TRMM MESH INTEGRATION LOCATED (for B.4 repoint — values NOT pasted here)
- `/rmm/api/tacticalrmm/tacticalrmm/local_settings.py` lines 24-29:
  `MESH_USERNAME` (MeshCentral account `lnpihhvs`), `MESH_SITE = "https://mesh.instaweb.top"`
  (line 25), `MESH_TOKEN_KEY` (line 29 — live secret, reference by line only).
- **Repoint is BLOCKED on instance-B account bootstrap:** that username/token are
  MeshCentral-A credentials; pointing TRMM at B without an equivalent account+token
  (+ a matching mesh group) breaks TRMM's mesh ops. Sequence: owner creates first
  admin account on `mesh.broks.beauty` (browser — `newAccounts:true` makes it admin) →
  generate login token → I create TRMM-equivalent user/token + private mesh group on B →
  then repoint the 3 keys + restart TRMM → verify.
- **Coordination flag for task agent (Section A.4):** the move-to-private flow needs its
  B-enrollment mechanism + private group id — hand off after B admin exists.
- `MESH_WSS_URL` still HELD (B.4b) until A.5 instance-aware resolver ships
  (private value will be `wss://mesh.broks.beauty`).
- `MESH_WSS_URL` still HELD (B.4b) until A.5 instance-aware resolver ships
  (private value will be `wss://mesh.broks.beauty`).
### B3 — TRMM REPOINT TO INSTANCE B — DONE (2026-10-19, all verified)
- **Token mechanism decoded (not a meshctrl `~t:` token):** TRMM's `MESH_TOKEN_KEY` IS
  MeshCentral's `LoginCookieEncryptionKey`. TRMM AES-GCM-encrypts an auth cookie
  (`meshctrl.utils.get_auth_token`, key[0:32]) and MeshCentral decodes it via
  `decodeCookie(req.query.auth, loginCookieEncryptionKey)`. B's key = 160-hex, read from
  `/meshcentral-b/meshcentral-data/meshcentral.db` (flat-file store). Pre-proof: TRMM's own
  crypto + real WS to B → `AUTH OK -> meshes: []` BEFORE any config touched.
- **Critical trap found + handled:** `USE_EXTERNAL_MESH` was ABSENT from local_settings →
  TRMM ignored `MESH_SITE` and hard-connected to `ws://127.0.0.1:4430` = **instance A's raw
  port**. So repointing `MESH_SITE` alone would have silently kept TRMM on A. Fixed by
  adding `USE_EXTERNAL_MESH = True`.
- **Applied** (backup `local_settings.py.bak-t230`): `MESH_USERNAME="myrate619"`,
  `MESH_SITE="https://mesh.broks.beauty"`, `MESH_TOKEN_KEY=<B LoginCookieEncryptionKey,
  reference only>`, `USE_EXTERNAL_MESH = True`. Restarted `rmm`/`celery`/`celerybeat` →
  all `active`.
- **`initial_mesh_setup` ran clean** → CoreSettings (DB) synced to
  `mesh.broks.beauty | myrate619 | 160`, and created the private mesh group on B:
  **`TacticalRMM`** (id `krFIGWP5Jktf$YOXZk3hoKa8pOpL4RepGDraqr800LoWyL2Y93sG05S1xl@LAGKv`).
- **VERIFIED by TRMM's own `check_mesh`:** `Mesh device group: TacticalRMM` · `Auth token ok` ·
  `Mesh url ok: wss://mesh.broks.beauty/control.ashx?auth=...` (no instaweb) ·
  `Mesh device id ok`. Control-channel listing returns the TacticalRMM group.
- **HANDED TO TASK AGENT (Section A.4):** private group id above + login `myrate619` on
  `mesh.broks.beauty` (group + login still stand). **CORRECTED by B3.1 below: TRMM's token
  key was reverted to instance A's key — it no longer holds B's.**
- **STILL HELD:** `MESH_WSS_URL` → instaweb until A.5 instance-aware resolver ships.
- **Existing private devices' MeshAgents still live in instance A** — re-enrollment to B is
  the known migration item (owner decision), not done here; TRMM agent check-ins unaffected.
### Proven: why apex still 520 (owner action needed)
- Public DNS: apex `instaweb.top` = **proxied (orange) → 172.67/104.21 (CF anycast)**;
  every working name is **grey-cloud → 164.68.105.96 direct**.
- Live nginx log watch during a CF-path probe: **0 requests arrive** — CF's edge never
  reaches this origin (no fail2ban, CF IPs not banned, no deny rules).
- **Verdict: the proxied apex record's origin in the CF dashboard is wrong** (stale IP /
  port / SSL mode). Box-side is proven-correct.
- **OWNER: fix in CF DNS — set apex `instaweb.top` A → `164.68.105.96` (or grey-cloud it
  like every other record here).** No CF API token exists on box/DB for this zone.
### Gotchas discovered for Section B2
- Port **3402 is already held by instance A itself** (same PID on 3401+3402) →
  Mesh-B gets a different port (plan 3403).
- **`mesh.broks.beauty` = NO_DNS and no CF token available anywhere** → OWNER must add
  the record (A → 164.68.105.96) before B2/B4b can proceed. `*.broks.beauty` wildcard
  cert already on box ✓.
- TRMM `MESH_SITE` not found in local_settings.py (grep empty) → locate its real
  config source before repointing Tactical at instance B. **[SUPERSEDED — B3 found it:
  local_settings.py line 25, synced into `core_coresettings` by `manage.py initial_mesh_setup`.]**
- instaweb apex 520 — fix it, or confirm only subdomains + links are actually used.
  **[RESOLVED — owner pointed apex + www at 164.68.105.96 DNS-only; parked vhosts now 200.]**

### B3.1 REGRESSION + FIX (2026-10-19 — remote control restored)
- **Regression:** B3's repoint (`MESH_SITE` + `MESH_TOKEN_KEY` → instance B) broke remote
  control for **all 26 nodes**, which live in instance A. `AgentMeshCentral` mints with
  `core.mesh_site` + `core.mesh_token` directly (agents/views.py:445-450), so every
  control/terminal/file URL pointed at `mesh.broks.beauty` signed with B's cookie key —
  and A rejected those sessions (`xid={}`). This was the reported disconnect.
- **Fix = byte-identical pre-B3 restore:** `MESH_USERNAME=lnpihhvs`,
  `MESH_SITE=https://mesh.instaweb.top`, `MESH_TOKEN_KEY` = A's key (160 hex), and removed
  `USE_EXTERNAL_MESH` (absent pre-B3 → TRMM's internal link goes direct to
  `ws://127.0.0.1:4430` again). Synced into CoreSettings via
  `/rmm/api/env/bin/python3 manage.py initial_mesh_setup`; `rmm/celery/celerybeat`
  restarted. Backups: `local_settings.py.bak-t230` (pre-B3), `.bak-t230-prefix` (B3 state).
- **Acceptance evidence:** DB `mesh_token` == pre-B3 backup key (byte compare **YES**) ·
  fresh mint → `control_base=https://mesh.instaweb.top/` with `login=` · GET minted URL →
  **200 + `Set-Cookie: xid`** (session `user//vantra-service__4`) = A accepts · target node
  exists in A as `node//$GXOrIYl…` (26 nodes total) · A's single mesh group name =
  **`TacticalRMM`**, matches CoreSettings `mesh_device_group` · `get_mesh_ws_url` →
  `ws://127.0.0.1:4430/control.ashx` · all five services **active**, zero err-log lines.
- **⚠️ DEPLOY BLOCKER FOR SECTION A.5:** the task agent's instance-aware mint maps
  **private → `mesh.broks.beauty`, but no nodes exist on B** — shipping A.5 as-is repeats
  this exact outage for every private device. A.5 may only ship together with the node
  migration (owner decision) or with a fallback that keeps mint → A while a node lives in A.
- **B's cookie key deliberately NOT aligned to A's** (considered): a shared login-cookie
  key = cross-instance session acceptance, which cuts against the isolation goal. Deferred
  as an A.5 design point: per-instance key at mint time vs. one shared key.
