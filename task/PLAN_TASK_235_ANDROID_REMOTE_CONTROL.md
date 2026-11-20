# PLAN_TASK_235 — Android remote control (aPuppet): server on the shared box + client split with Michael

> **Docs-only for now.** No box changes until the owner gives 🚦 for S1.
> Scope of THIS document: the SERVER half (aPuppet server patched onto the existing
> production VPS) and the split of work between the owner (server) and Michael (client).
> The client half (Phases 2–6 of the aPuppet blueprint) is Michael's lane; this plan only
> records its boundaries and hard dependencies.

---

## 1. Owner decisions (verbatim, binding)

1. *"now lets plan to have the android agent added to our platform....the first part is to
   plan and see how the server can work with this. then we split the task,, i handle the
   server part, and michael handles the client side......but server would be first ...lets
   scope this first"*
2. Host decision (this session): **Option B — patch aPuppet onto the production VPS
   (164.68.105.96, Ubuntu 22.04) with the 22.04 patch set.** No new VM, no new cost.
   (Rejected: fresh Ubuntu 20.04 VM on the same box.)
3. *"dont edit . just plan"* — planning pass completed in plan mode; THIS file is its
   output. Box state unchanged so far.

Reading: server comes first; Michael may start immediately on work that does not need the
server (fork/Gradle baseline), but his "connects to our server" gate waits for S3.

## 2. Goal (from the aPuppet blueprint, unchanged)

A remote-control system for Android devices, modeled on TeamViewer:

- **Mode 1 (attended):** guided setup once; each session approved on the phone — the phone
  shows a session ID + password that the controller types into web-admin.
- **Mode 2 (unattended):** device enrolled once, assigned to an account; where the OS
  allows, no prompt; otherwise falls back to Mode 1. **Gated:** if device-owner
  provisioning does not remove per-session consent, Mode 2 ships as notification-and-tap.

## 3. Decision: shared box (Option B)

| Option | Verdict |
|---|---|
| A — fresh Ubuntu 20.04 VM (blueprint default) | Rejected: adds cost + RAM pressure (host at 17.8/31.4 GiB when checked), installs a duplicate Docker/nginx/certbot stack |
| **B — patch aPuppet onto 164.68.105.96 (22.04)** | **CHOSEN:** no cost; resources fine (8 vCPU, ~16 GiB free RAM, 116 GB disk); port pre-check clean; required patches fully understood from research |

The 2020-era installer needs a defined patch set because it hard-rejects
non-16.04/18.04/20.04, pins `ansible=2.9.*` (absent on jammy), assumes docker-compose v1
(box has only the compose v5 plugin), and its nginx container runs `network_mode: host` —
a bind collision with production nginx on :80/:443. **The design eliminates aPuppet's
nginx entirely; existing host nginx + host certbot own the web tier.**

## 4. Verified facts this plan is built on (researched 2026-10-20, all read-only)

| # | Fact | Source |
|---|---|---|
| 1 | Installer hard-rejects non-16.04/18.04/20.04; apt-pins `ansible=2.9.*` | upstream `install.sh` |
| 2 | nginx + Janus containers run `network_mode: host`; nginx would bind host 80/443 | `deploy/templates/docker-compose/docker-compose.yaml.j2` |
| 3 | Ports configurable + nginx toggleable: `is_nginx_enabled`, `is_certbot_enabled`, api_http **8088**, api_https **8089**, api_wss **8989**, RTP **10000–10500**, admin API off (7889) | `deploy/config.defaults.yaml` |
| 4 | TCP 8088/8089/8989 and UDP 10000–10500 FREE on the box; ufw inactive, INPUT ACCEPT; public coturn already serves :3478 | `ss -ltnp` / `ss -lun` / `ufw status` |
| 5 | Janus serves its own TLS: WSS 8989 + HTTPS 8089 reading `/etc/letsencrypt/live/<hostname>/` (mounted from `deploy/dist/ssl`); CORS pinned to `https://<hostname>` | `janus.transport.websockets/http.jcfg.j2` |
| 6 | web-admin `settings.js` derives `wss://<hostname>:8989` + `https://<hostname>:8089/janus` from page hostname; plain `ws://` hard-disabled on https pages | `deploy/templates/web-admin/settings.js.j2` |
| 7 | Stock nginx: `/` → 302 `/web-admin/`, alias to web-admin files, `/janus` → proxy `127.0.0.1:8088` — all replicable as one host vhost | `deploy/templates/nginx/nginx.conf.j2` |
| 8 | Images exist and are actively pulled: `headwindmdm/janus-gateway:0.10.7`, `headwindmdm/node-gulp-builder:15.2.0-alpine3.12-0.1` (status active, last pulled 2026-10-19) | Docker Hub API |
| 9 | **Mode 1 flow confirmed in the stock app:** the PHONE generates/displays session ID + password ("send the server URL, session ID, and password to the supervisor") and can share an invitation link — no server-side accounts needed for Mode 1 | apuppet-android `strings.xml` |
| 10 | Installer aborts if the domain does not resolve to the server's IP → a Cloudflare-PROXIED record breaks it; the record must be DNS-only | upstream README |

## 5. Target architecture on the shared box

```
                      164.68.105.96 (existing box — nothing existing is removed)
┌─ host nginx (already owns :80/:443) ────────────────────────────────┐
│  NEW vhost: apuppet.<domain>                                        │
│    /            → 302 /web-admin/                                    │
│    /web-admin/   → alias /opt/apuppet/deploy/dist/web-admin/ (static)│
│    /janus        → proxy 127.0.0.1:8088                              │
│    TLS: NEW host-certbot lineage (box already runs certbot 1.21)     │
└──────────────────────────────────────────────────────────────────────┘
   aPuppet nginx container   : DISABLED (is_nginx_enabled:false)  ← collision removed
   aPuppet certbot container : DISABLED (skipped when nginx off)  ← host certbot rules
   Janus container           : runs, network_mode:host
       TCP 8088 (HTTP) · TCP 8089 (HTTPS) · TCP 8989 (WSS)  ← verified free
       UDP 10000–10500 (RTP)                                 ← verified free
       TLS certs: deploy/dist/ssl/live/<hostname>/ ← COPY of host lineage
                  renewed by host certbot deploy-hook → copy + restart janus
   coturn :3478 (already running) — candidate TURN, decision deferred to E2E evidence
```

**Why this shape:** Janus must keep serving WSS/HTTPS itself (`settings.js` bakes in
`wss://host:8989` and plain `ws://` is disabled on https pages), so Janus keeps direct
ports and takes its certs from a host-issued lineage; only static files go through host
nginx. No WS proxying, no port juggling, and aPuppet's full-file nginx config (which would
replace `/etc/nginx/nginx.conf`) **never runs**.

**Cert-first ordering:** issue the host lineage *before* starting Janus
(`certbot certonly --webroot` against the new vhost's ACME location — same workflow as the
box's existing 8 lineages), populate `deploy/dist/ssl/live/<hostname>/{fullchain,privkey}.pem`,
then start. A certbot deploy hook keeps renewal automatic: copy renewed files + restart the
janus container (guarded so it no-ops when the container is absent).

## 6. Patch set — maintained as a fork of apuppet-server under the org (reproducible, reviewable)

| File | Change | Why |
|---|---|---|
| `install.sh` | Allow `22.04` in the case; install Ansible without the `=2.9.*` pin (apt `ansible` on jammy, or pinned ansible-core via pip + `community.docker`) | Distro gate / missing pin |
| `deploy/install.yaml`, `deploy/start.yaml` | `docker-compose` → `docker compose` (plugin v5.5.1); Ansible docker/compose module → `community.docker.docker_compose_v2` or direct compose commands; **skip ACME-issuance tasks** (certs pre-provisioned) | No compose v1 on box; cert-first ordering |
| `deploy/config.defaults.yaml` (or `config.yaml` override — verify merge order first) | `is_nginx_enabled: false` (certbot container is guarded by `certbot and nginx`, so it skips automatically); keep SSL **on** so Janus WSS/HTTPS stay up | Host nginx takes over web tier |
| root `config.yaml` | `hostname: apuppet.<domain>`, owner email | Ownership check + cert paths |
| (runtime, not repo) host vhost + certbot deploy-hook script | §5 | Web tier + renewal |

**Fallbacks** (record in STEPS if a patch bites):
- Run playbooks with `--check` first; if module patches fight back, hand-execute the
  templating diffs (script-file rule: write → `bash -n` → run → read log).
- If `ssl_enabled` turns out hard-wired to `is_certbot_enabled`, decouple the two vars in
  the playbook rather than re-enabling the container.
- If jammy Ansible packaging fights the collections: pip ansible-core +
  `ansible-galaxy collection install community.docker` escape hatch.

## 7. Server execution phases (owner = server lane)

**S0 — Write the plan docs** ✅ *this file + `TASK_235_ANDROID_SERVER_STEPS.md`*

**S1 — DNS + preflight** *(needs open item 1: the subdomain)*
- A record `apuppet.<domain>` → `164.68.105.96`, **proxied-off / DNS-only** (CF proxy
  breaks the ownership check; RTP cannot traverse CF anyway). `dig +short` = box IP.
- `docker pull` both image tags; clone the patched fork to `/opt/apuppet`
  (**its own dir — NOT inside `/opt/spaceworker`**).
- *Gate:* DNS verified, images pulled.

**S2 — Cert-first, patched install**
- Backup `/etc/nginx/sites-enabled` → dated snapshot; write vhost script
  (`bash -n` → run → `nginx -t` → graceful reload).
- Issue lineage → populate `deploy/dist/ssl/live/<hostname>/` → add deploy hook.
- Patched `install.sh`; compose stack up (**Janus only**).
- *Gate (box evidence):* container up · `https://apuppet.<domain>/web-admin/` → 200 ·
  `curl https://apuppet.<domain>:8089/janus/info` → 200 · `wss://…:8989` TLS handshake OK ·
  regression pins probed (SW `/` 200, `/login` 307, vantra alive).

**S3 — Mode 1 E2E with the STOCK Play Store app** (validates the server before Michael builds)
- Settings → server URL + `janus_api_secret` (from `deploy/dist/credentials/`) → phone
  shows session code → web-admin joins → video + gesture round-trip.
- Matrix: phone on Wi-Fi AND cellular; log ICE candidates → **TURN decision**
  (reuse existing coturn :3478 vs. configure a TURN realm) on evidence only.
- External reachability probes for TCP 8088/8089/8989 + UDP 10000–10500 (provider side).
- *Gate:* session works from cellular; actual ports/URLs recorded → the contract.

**S4 — Publish interface contract to Michael**
- Server URL, `janus_api_secret` (secure channel, never committed), port/firewall list,
  exact Mode 1 flow + screenshots, cert-renewal behavior, Phase 5 API sketch (§8).

## 8. Phase 5 design sketch — server side (account/device registry; built AFTER S3)

Additive-only changes to the spaceworker repo (normal lane rules: branch → 🚦 →
verification pins → owner deploy):

- **Prisma (additive):** `AndroidDevice` (id, alias, device hash, credentialHash,
  enrolledAt, lastSeenAt, revokedAt, ownerId), `AndroidSession` (audit: session code hash,
  startedAt, endedAt, controllerAdminId, endReason).
- **APIs (internal/authed):** `POST /api/android/enroll` (one-time code → permanent
  per-device credential), `POST /api/android/heartbeat` (keep-alive + reachability),
  `GET/POST /api/android/devices` (list, rename, revoke), `GET /api/android/sessions`
  (audit log).
- **Web-admin spike:** device list + "Connect" action — first test of whether a
  full-screen overlay canvas (keyboard + touch relay) beats iframes/occluded windows
  (known risk in the kiosk-app). Small spike before committing UI shape.
- **Wake channel decision:** FCM (needs a Firebase project; solves background wake but
  brings Play-policy weight later) vs. persistent outbound connection device → server
  (works today, no Google dependency, but OEM battery killers). Decide at S4 on S3 evidence.
- **Safeguards (design now, ship with Phase 5):** persistent "being controlled" indicator,
  session audit log, owner-side kill switch for remote access.
- **Gate (blueprint rule, restated):** if device-owner provisioning does not remove
  per-session consent on a real phone, Mode 2 = notification-and-tap only — nobody builds
  the prompt-free path hoping it will pass.

## 9. Task split (owner: *"i handle the server part, and michael handles the client
side......but server would be first"*)

| Lane | Scope | Start | Gate dependency |
|---|---|---|---|
| **Owner — server** | S0–S4 (install, cert, vhost, Mode 1 E2E, contract), then Phase 5 server: registry schema/APIs, web-admin device-list spike, wake channel, audit log — spaceworker-repo work riding normal CI | now | — |
| **Michael — client** | Phase 2 fork baseline (replace JCenter, Gradle/AGP, compileSdk/targetSdk, WebRTC dep, Firebase decision, manifest fixes `android:exported` / POST_NOTIFICATIONS / FOREGROUND_SERVICE_MEDIA_PROJECTION, server URL+secret in `build.gradle`), Phase 3 Android 14/15 capture, Phase 4 guided onboarding | **immediately** — Phase 2 needs no server | "connects to our server" waits on S3; Phase 5 client (enrollment UI, boot receiver, FCM, one-tap approval) **hard-blocked on the S4 contract** |

**Handoffs:** owner → Michael: URL, secret, ports, flow doc, Phase 5 contract
(`HANDOFF_T235_APUPPET_TO_MICHAEL.md`, written at S4). Michael → owner: APK + exact
endpoints/push requirements he calls, so Phase 5 server APIs match client reality.

## 10. Safety posture (shared-box specific)

**Never-run list:**
- aPuppet's `nginx.conf.j2` as a system config (it would replace `/etc/nginx/nginx.conf`)
  — prevented by `is_nginx_enabled:false`.
- `docker compose down` anywhere outside `/opt/apuppet`; any change to spaceworker/
  vantra/mesh units; edits to `.env`.
- Clone MUST NOT live inside `/opt/spaceworker` (repo-root trap) — it goes to `/opt/apuppet`.

**Rollback:** remove the vhost symlink → `nginx -t` → `systemctl reload nginx`;
`docker compose down` in `/opt/apuppet`; remove the lineage + staged `dist/ssl` copy +
deploy hook. Box returns to pre-S2 state; **zero spaceworker restarts ever required.**
Nginx reload is graceful, but probe the regression-pin set after any nginx touch
(🚦 + verification-agent rules).

## 11. Risks (from the blueprint, unchanged)

1. **Per-session consent:** Android requires it; no documented bypass. Prompt-free Mode 2
   is unverified → the S3 evidence gates exist exactly for this.
2. **Old dependencies:** 2020 stack; §6 covers the known ones (ansible pin, compose v1,
   Ansible docker module, image tags — images verified alive 2026-10-19).
3. **Manufacturer behavior:** brand-specific background-app killing — Mode 2 reachability only.
4. **Google Play policy:** remote-control + accessibility apps face restrictions — check
   current rules before publishing; sideload-first is the default distribution.
5. **Sideloading:** Android 13+ "allow restricted settings" extra step — Phase 4 help screen.

## 12. Open items (owner calls at execution time)

1. **Subdomain + DNS home** — candidate `apuppet.spaceworker.top` on the CF account
   (**must stay DNS-only / proxied-off**) vs. a Truehost-managed domain (blueprint's
   Truehost note). Binding for S1. Default if no call: `apuppet.spaceworker.top`.
2. **TURN** — deferred to S3 evidence; existing coturn :3478 may make it free.
3. FCM/Firebase project + Play-policy decision — Phase 5/later, not server-critical.
4. Task number: **235** (verified free at write time; 234 was highest used).
5. **Michael's SSH key (BLOCKER — see §13)** — Michael cannot start any server-side work
   until he has generated a key and sent you the public half. No server access = no
   fork clone, no docker commands on 164.68.105.96, no certbot/nginx touch.

## 13. Michael's server access blocker — SSH key generation

**This is a hard blocker:** Michael's server work (cloning the patched fork to
`/opt/apuppet`, running docker compose, certbot, nginx reload on 164.68.105.96)
requires an SSH key on the box. Until you receive his public key and install it,
Michael is limited to client-only work (Phase 2 fork baseline) that does not touch
the server.

### What Michael does (send him these exact steps)

```
# 1. Generate the key (enter for empty passphrase, or set one if you prefer)
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_android -C "michael-android-server"

# 2. Show the PUBLIC key — copy this ENTIRE block and send it to the owner.
#    NEVER send the private key (~/.ssh/id_ed25519_android).
cat ~/.ssh/id_ed25519_android.pub
```

### What you (the owner) do on 164.68.105.96

Once you have Michael's public key block:

```
# 1. Create the system user (pick 'michael' or another name)
adduser michael

# 2. Install his public key (paste the key he sent you into the heredoc)
mkdir -p /home/michael/.ssh
cat > /home/michael/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAA... <the full public-key block Michael sent you>
EOF

# 3. Lock down permissions
chown -R michael:michael /home/michael/.ssh
chmod 700 /home/michael/.ssh
chmod 600 /home/michael/.ssh/authorized_keys

# 4. Docker access (so he can run compose in /opt/apuppet without sudo)
usermod -aG docker michael

# 5. Sudo — choose ONE:
#    a) Full sudo (matches ubuntu/trmm pattern):
#       echo 'michael ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/michael
#    b) Scoped sudo (docker + nginx + certbot only — safer):
#       write /etc/sudoers.d/michael with a narrow Cmnd_Alias
```

Then verify:

```
# From YOUR machine (not the box), as a smoke test:
ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes michael@164.68.105.96 'whoami; docker ps | head'
```

Michael logs in with: `ssh michael@164.68.105.96` (using `~/.ssh/id_ed25519_android`).

**Why a dedicated user instead of sharing your key:** shared key = no audit trail,
can't revoke Michael without revoking you, and root login from his machine widens the
blast radius if his laptop is ever compromised. Revoking access later = remove his
`authorized_keys` entry and `userdel michael`.


