# TASK_235 — ANDROID REMOTE CONTROL (SERVER HALF): SHARED-BOX APUPPET INSTALL — STEPS

Scope: server lane only — patch-install the aPuppet server (Janus + web-admin) onto the
existing production VPS 164.68.105.96 (Ubuntu 22.04), fronted by the existing host nginx,
validated end-to-end with the STOCK Play Store app, then publish the interface contract to
Michael. Lane: SERVER/INFRA, owner executes. READ `PLAN_TASK_235_ANDROID_REMOTE_CONTROL.md`
FIRST — this file is only the executable checklist.

Rules for this task:
- **All box operations via script files:** write with editor → `bash -n` → run → read the
  log (`/root/t235_<step>.log`). No ad-hoc one-liners pasted into ssh.
- **Never:** touch `/etc/nginx/nginx.conf`, run aPuppet's nginx/certbot containers, run
  `docker compose down` outside `/opt/apuppet`, touch spaceworker/vantra/mesh units, edit `.env`.
- **Never** place the clone inside `/opt/spaceworker` — it goes to `/opt/apuppet`.
- Any nginx touch ⇒ probe the regression pins (S2 step 2) before finishing.
- 🚦 Owner gives explicit go before S1 and before S2 (nginx + containers on prod box).

## Owner decisions (verbatim, binding)

1. *"now lets plan to have the android agent added to our platform....the first part is to
   plan and see how the server can work with this. then we split the task,, i handle the
   server part, and michael handles the client side......but server would be first ...lets
   scope this first"*
2. Host: **Option B — patch onto 164.68.105.96 (22.04), no new VM.**
3. *"dont edit . just plan"* (planning phase — now superseded by act mode for doc writing).

## BEFORE — session state (recorded 2026-10-20, read-only)

### Box (root@164.68.105.96, key `~/.ssh/tacticalrmm_vps`)
- OS: Ubuntu **22.04.5** LTS · 8 vCPU · 31.4 GiB RAM (17.8 used) · 116 GB free on `/`.
- nginx **1.30.3** owns :80/:443 (spaceworker 3000, vantra 3001, mesh 8443/20000+,
  9 vhosts incl. `mesh.spaceworker.top`).
- **Ports free:** TCP 8088, 8089, 8989, 7889 · UDP 10000–10500. ufw **inactive**,
  INPUT ACCEPT (probe externally — provider firewall may still filter).
- Docker **29.5.3** + compose **v5.5.1** (plugin ONLY — no docker-compose v1).
- Ansible **not installed**. apt available. certbot **1.21.0** (host) with 8 lineages,
  `certbot.timer` active (auto-renew). Public **coturn on :3478** already running.
- Resources/time fine; containers: tacticalrmm, meshcentral, spaceworker-app (compose).

### spaceworker repo
- No code changes for this task. This PLAN + STEPS pair is the only output of S0.
- Untracked task docs from earlier tasks exist; never stage files that are not yours.

## Recon findings (file-grounded)

Full evidence table: `PLAN_TASK_235_ANDROID_REMOTE_CONTROL.md` §4 (10 verified facts —
installer gates, host-network collision, configurable ports, Janus self-TLS cert paths,
settings.js endpoint derivation, stock nginx locations, image liveness on Docker Hub,
stock-app Mode 1 flow, DNS ownership check). Patch set: PLAN §6. Architecture: PLAN §5.

### S0 — Plan docs ✅ (2026-10-20)
- [x] `PLAN_TASK_235_ANDROID_REMOTE_CONTROL.md` written.
- [x] `TASK_235_ANDROID_SERVER_STEPS.md` (this file) written.

### S1 — DNS + preflight 🚦 (owner go required; needs subdomain decision, PLAN §12.1)
- [ ] **Owner:** create DNS A record `apuppet.<domain>` → `164.68.105.96`,
      **DNS-only (proxied OFF)**. Default candidate: `apuppet.spaceworker.top`.
- [ ] Verify: `dig +short apuppet.<domain>` → `164.68.105.96` — evidence: dig output → `/root/t235_s1_dig.log`
- [ ] Script `t235_s1_preflight.sh` (editor → `bash -n` → run):
      `docker pull headwindmdm/janus-gateway:0.10.7`,
      `docker pull headwindmdm/node-gulp-builder:15.2.0-alpine3.12-0.1` — evidence: pull status → `/root/t235_s1_pull.log`
- [ ] Fork `apuppet-server` under the org; apply PLAN §6 patch set as commits on the fork
      (repo-side work, not on the box); then clone to **`/opt/apuppet`** — evidence: `ls /opt/apuppet/install.sh` + `git log --oneline`
- [ ] *Gate:* DNS = box IP · images pulled · patched clone in place.

### S2 — Cert-first, patched install 🚦 (owner go required — touches prod nginx + new containers)
- [ ] Script `t235_s2_backup.sh`: `cp -a /etc/nginx/sites-enabled /root/nginx-sites-enabled.bak-$(date +%Y%m%d-%H%M%S)`
      and `cp -a /etc/letsencrypt /root/letsencrypt.bak-$(date +%Y%m%d-%H%M%S)` (renewal confs get a deploy hook later) — evidence: `ls -d /root/nginx-sites-enabled.bak-*`
- [ ] Script `t235_s2_vhost.sh`: write `/etc/nginx/sites-available/apuppet.conf` —
      `server_name apuppet.<domain>`; `:80` → ACME `location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }` + `return 302 https://$host$request_uri;`;
      `:443 ssl http2` → cert `/etc/letsencrypt/live/apuppet.<domain>/{fullchain,privkey}.pem`;
      `location / { return 302 $scheme://$host/web-admin/; }`;
      `location ^~ /web-admin/ { alias /opt/apuppet/deploy/dist/web-admin/; index index.html; }`;
      `location ^~ /janus { proxy_pass http://127.0.0.1:8088/janus; }`
      — enable symlink, `nginx -t`, `systemctl reload nginx` — evidence: `nginx -t` output → `/root/t235_s2_vhost.log`
- [ ] **Regression pins immediately after reload** (script `t235_s2_pins.sh`):
      `curl -s -o /dev/null -w '%{http_code}' https://spaceworker.top/` → **200** ·
      `/login` → **307** · vantra known pin → baseline status ·
      `https://mesh.spaceworker.top` → known status. Record ALL codes; any drift = STOP + rollback (HANDOFF).
- [ ] Script `t235_s2_cert.sh`: `certbot certonly --webroot -w /var/www/certbot -d apuppet.<domain> --non-interactive --agree-tos -m <owner-email>`
      — evidence: `certbot certificates | grep apuppet` → ACTIVE → `/root/t235_s2_cert.log`
- [ ] Script `t235_s2_sslstage.sh`: mkdir -p `/opt/apuppet/deploy/dist/ssl/live/apuppet.<domain>/` and copy
      `fullchain.pem` + `privkey.pem` there (chmod 600/700) — Janus reads exactly these paths (PLAN §4 fact 5).

- [ ] Script `t235_s2_hook.sh` → install to `/etc/letsencrypt/renewal-hooks/deploy/apuppet-renew.sh`:
      re-copy both files to the staged path, then restart the janus container via
      `docker compose -f <compose file> restart janus 2>/dev/null || true`
      (exact compose path confirmed from install output; guard keeps hook idempotent).
- [ ] Set root `config.yaml` in the clone: `hostname: apuppet.<domain>` + owner email;
      ensure `is_nginx_enabled: false` wins the merge (verify how config.yaml layers over
      `deploy/config.defaults.yaml` before running).
- [ ] Script `t235_s2_install.sh`: `cd /opt/apuppet && ./install.sh 2>&1 | tee /root/t235_s2_install.log`
      — read the log: expect NO aPuppet nginx/certbot containers, Janus Up, gulp builder ran.
      If an ansible/compose/module patch bites → fix IN THE FORK, re-run, record the
      deviation here (fallbacks: PLAN §6).
- [ ] Verify stack — script `t235_s2_verify.sh`, evidence → `/root/t235_s2_verify.log`:
      - `docker ps` → janus container Up; NO aPuppet nginx/certbot containers
      - `curl -s -o /dev/null -w '%{http_code}' https://apuppet.<domain>/web-admin/` → **200**
      - `curl -s https://apuppet.<domain>:8089/janus/info` → Janus JSON **200**
      - `curl -s http://127.0.0.1:8088/janus/info` → Janus JSON (local HTTP leg)
      - `timeout 5 openssl s_client -connect apuppet.<domain>:8989 -servername apuppet.<domain> </dev/null` → handshake OK, cert CN=apuppet.<domain>
      - `ss -ltn | grep -E ':8088|:8089|:8989'` → LISTEN; `ss -lun` shows RTP 10000–10500
      - regression pins from step 3 re-run → unchanged
- [ ] *Gate:* all green + regression pins unchanged → 🚦 owner confirms S3.

### S3 — Mode 1 E2E, STOCK Play Store app
- [ ] Install stock aPuppet from Play Store on a test phone (Android 14/15 preferred).
- [ ] App Settings → Server URL `https://apuppet.<domain>/web-admin/` + secret read on box
      from `/opt/apuppet/deploy/dist/credentials/` — **never commit, never paste into docs**.
- [ ] Phone shows session ID + password → enter in web-admin → system screen-share dialog →
      approve → **video streams**.
- [ ] Gesture round-trip: tap, type, scroll — phone responds in the browser.
- [ ] Rotate phone → session survives; note lock-screen behavior.
- [ ] Phone on **cellular (Wi-Fi off)** → repeat full session. Record ICE candidate types
      from web-admin console (host/srflx/relay) → **TURN decision** (reuse coturn :3478 vs.
      new TURN realm) — evidence → this file.
- [ ] External TCP reachability for 8088/8089/8989 from outside the box (provider firewall) —
      evidence: third-host `nc -vz` OR the successful cellular session itself.
- [ ] End session cleanly → phone notification clears, web-admin back to idle.
- [ ] *Gate:* cellular session works; evidence recorded → contract (S4).

### S4 — Interface contract → Michael (write `HANDOFF_T235_APUPPET_TO_MICHAEL.md`)
- [ ] Contract fields: server URL · secret delivery channel (secure, never git) ·
      port/firewall list · exact Mode 1 user flow with screenshots · cert-renewal behavior
      (janus restart blip ≈ seconds) · Phase 5 API sketch (PLAN §8: enroll / heartbeat /
      devices / sessions + wake-channel options: FCM vs persistent connection) · known
      limitations from S3 (TURN status, device quirks).
- [ ] Michael may already be mid-Phase-2 — send the contract the moment S3 gates.

## HANDOFF → VERIFICATION AGENT
- **Docs-only S0:** verify both files exist and are internally consistent
  (`PLAN_TASK_235_ANDROID_REMOTE_CONTROL.md`, `TASK_235_ANDROID_SERVER_STEPS.md`); no
  tracked repo files changed by S0.
- **S1 gate:** `dig +short apuppet.<domain>` = `164.68.105.96` (DNS-only — `dig` must NOT
  return CF proxy IPs); both image pulls succeeded on the box.
- **S2 gate (box evidence, re-run independently):** web-admin 200 over HTTPS ·
  `:8089/janus/info` 200 · `:8989` TLS handshake with correct CN · janus container Up and
  NO aPuppet nginx/certbot containers · **regression pins byte-identical to pre-S2
  baseline** (spaceworker `/` 200, `/login` 307, vantra + mesh statuses) · rollback assets
  present (`/root/nginx-sites-enabled.bak-*`, letsencrypt backup).
- **S3 gate:** a recorded Mode 1 session from **cellular** (screenshots/video), ICE
  candidate log, TURN decision written down, clean session end.
- **Security:** secret never in git/docs/commits; HTTPS-only endpoints; `curl` to :8088
  (plain HTTP) documented as local-only or accepted risk.
- **STOP conditions:** any regression-pin drift after the nginx reload → rollback per
  PLAN §10 (remove vhost → `nginx -t` → reload; `docker compose down` in `/opt/apuppet`)
  and escalate to owner.


