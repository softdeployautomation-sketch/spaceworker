# TASK_254-B — Android RC backend + dashboard (`android-rc/server`)

Owner decision (2026-11-09): **"I need all set first before downloading, so I can see it
when it's connected."** So this task must deliver a deployed, working backend + viewer
BEFORE the owner installs the APK. The APK is already hosted (see §0); it points at
`https://android.spaceworker.top` and `ssl://android.spaceworker.top:8883` by default.

Read first: `PLAN_TASK_254_ANDROID_AGENT.md`, `SENIOR_T254_ANDROID_VERIFICATION.md`
§2.1–§2.3, and `android-rc/CLAUDE.md` (client protocol; ignore its stale package name).

---

## 0. What already exists (do not rebuild)

- APK hosted and verified:
  - `https://spaceworker.top/downloads/android/spaceworker-rc-agent-debug.apk`
    (sha256 `e3d66ce5…daec8970`, 15,121,132 bytes)
  - `https://spaceworker.top/downloads/android/spaceworker-rc-agent-release.apk`
- CI build: `.github/workflows/android-build.yml`, run `42585417527`, branch
  `task-254-android-agent` @ `10177ad`.
- Client is frozen except for defects found while testing T254-B. Do not re-vendor.

---

## 1. Client contract (must match exactly — verified from source)

| Item | Value |
|---|---|
| MQTT broker default | `ssl://android.spaceworker.top:8883` (`BuildConfig.MQTT_BROKER`) |
| MQTT username | `deviceId` = `Settings.Secure.ANDROID_ID` (16 hex chars) unless build override |
| MQTT password | the enrollment code the user types on the onboarding screen (saved to `mqtt_password`) |
| MQTT client id | `deviceId` |
| MQTT protocol | MQTT 5, clean start, keepalive 60 s, LWT `rc/state/<id>` retained `{"online":false}` |
| Topics | `rc/cmd/<id>` (device subscribes), `rc/state/<id>` (retained, QoS 1), `rc/probe/<id>`, `rc/event/<id>` |
| Commands | `probe`, `selfheal`, `session.start` (`wsUrl` + `token`), `session.stop`, `maintenance.start`, `maintenance.stop` |
| Device → relay | binary 9-byte header + payload; `0x01` config (SPS/PPS), `0x02` key, `0x03` delta, `0x04` JPEG; plus JSON text `{"t":"log",...}` diag |
| Relay → device | JSON text: `{"t":"hello"}`, `{"t":"viewer.join"}`, `{"t":"touch"|"pointer","action","nx","ny","pointerId"}`, `{"t":"key","k"}`, `{"t":"text","v"}`, `{"t":"scroll","nx","ny","dy"}` |
| Device relay URL | exactly `wsUrl + "?token=" + urlencode(token)`; `wsUrl` may already contain query params |
| Default capture | Accessibility `takeScreenshot` → **JPEG `0x04`** (no MediaProjection prompt). H.264 is opt-in. |
| Server URL field | user enters `https://android.spaceworker.top`; only the host is saved. **MQTT broker does NOT follow this field** — it stays at the build default. Deploy at that exact hostname. |
| Device HTTP enroll | **none** — the current APK never calls an HTTP enroll endpoint. The code is used directly as the MQTT password. |

Implication: Phase 1 MQTT auth = one rotatable **fleet enrollment code** accepted for any
`deviceId` username, with ACL restricting each username to its own topics. Per-device
codes/tokens are T254-C.

---

## 2. Architecture

```
android-rc/server/
├ docker-compose.yml          # mosquitto + rc-api + rc-relay
├ .env.example                # RC_ENROLL_CODE, MQTT_HOST, TOKEN_SECRET, DB_PATH, ...
├ mosquitto/
│  ├ mosquitto.conf           # 8883 TLS, go-auth HTTP backend
│  ├ acl                       # fallback static ACL if needed
│  └ certs/                    # mounted from /etc/letsencrypt (host)
├ api/                        # rc-api: Fastify/Express, SQLite, MQTT client, auth+ACL
├ relay/                      # rc-relay: ws server, pairing, key/config cache
├ web/                        # rc-web: static viewer (JPEG first, H.264/WebCodecs optional)
├ deploy/
│  ├ install.sh               # copy to /opt/android-rc, compose up, systemd
│  ├ nginx-android.conf       # android.spaceworker.top vhost
│  ├ certbot.sh
│  └ verify.sh                # regression pins + E2E
└ test/
   ├ fake-device.mjs          # MQTT device + relay client, synthetic JPEG
   └ *.test.mjs               # node:test unit tests
```

Ports (box):
- `8883/tcp` — Mosquitto TLS, public (provider firewall may need opening; ufw inactive).
- `127.0.0.1:8090` — rc-api HTTP (nginx proxies `/api/`).
- `127.0.0.1:8081` — rc-relay WSS (nginx proxies `/relay` with Upgrade).
- Static viewer served by nginx from `/opt/android-rc/web`.

MQTT auth (primary): `iegomez/mosquitto-go-auth` with the HTTP backend calling
`rc-api` (`/mqtt/auth`, `/mqtt/superuser`, `/mqtt/acl`). If go-auth cannot be made
reliable, **EMQX 5** with HTTP authn/authz is the approved fallback — document the
switch and keep the same auth/ACL semantics. Do not ship anonymous MQTT.

---

## 3. Data model (SQLite, additive)

- `devices(id TEXT PK, name TEXT, last_seen INTEGER, online INTEGER, caps_json TEXT,
  agent_ver TEXT, created_at INTEGER)`
- `sessions(id TEXT PK, device_id TEXT, token_hash TEXT, created_at INTEGER,
  expires_at INTEGER, closed_at INTEGER)`
- `enroll_codes(code_hash TEXT PK, label TEXT, created_at INTEGER, revoked INTEGER)`
  (Phase 1: one row for the fleet code from `.env`; T254-C adds per-device codes.)

---

## 4. Steps

### S0 — Owner prerequisites 🚦
- [ ] **Owner:** create DNS A record `android.spaceworker.top` → `207.244.224.57`,
      **DNS-only (Cloudflare proxy OFF)**. Verify `dig +short android.spaceworker.top`.
- [ ] **Owner:** confirm 🚦 GO before S7 (box deploy) and before S8 (live).
- [ ] Record the DNS output in `TASK_254_STEPS.md` (T254-B section).

### S1 — Scaffold + local compose
- [ ] Create `android-rc/server/` layout above; `package.json` (`type: module`,
      Node 20, scripts `dev`, `test`, `e2e`); `.env.example` with placeholders only.
- [ ] `docker-compose.yml`: mosquitto 8883 (TLS optional in dev), rc-api, rc-relay.
      Bind API/relay to `127.0.0.1` on the box; 8883 public.
- [ ] Generate a strong `RC_ENROLL_CODE`; keep it only in `.env` (gitignored) and
      **report it to the owner in the final message** (never commit it).
- [ ] `npm install`; `npm test` runs (even if empty) — evidence to `/tmp/t254b_s1.log`.

### S2 — rc-api
- [ ] `POST /mqtt/auth` → `{ok:true}` iff `password === RC_ENROLL_CODE` and username is
      non-empty; log failures without the password.
- [ ] `POST /mqtt/superuser` → true only for the internal `rc-api` MQTT user.
- [ ] `POST /mqtt/acl` → allow `rc/cmd|state|probe|event/<username>` for the matching
      username; deny everything else; internal user gets `rc/#`.
- [ ] `GET /api/devices` → list from SQLite + retained `rc/state/+` (online, lastSeen, caps).
- [ ] `POST /api/devices/:id/session` → create session, HMAC token (`TOKEN_SECRET`,
      10 min TTL), publish `session.start` to `rc/cmd/:id` with
      `{"wsUrl":"wss://android.spaceworker.top/relay?session=<id>&role=device","token":"<token>"}`;
      return `{sessionId, wsUrl:"wss://android.spaceworker.top/relay?session=<id>&role=viewer&token=<token>"}`.
- [ ] `POST /api/devices/:id/command` → `{cmd}` publishes to `rc/cmd/:id` (allowlist:
      `probe`, `selfheal`, `session.stop`, `maintenance.start`, `maintenance.stop`).
- [ ] `GET /api/health` → `{ok:true, mqtt:true, db:true}`.
- [ ] Subscribe `rc/state/+` (retained) and `rc/event/+`; upsert devices; never log secrets.

### S3 — MQTT broker + auth/ACL
- [ ] `mosquitto/mosquitto.conf`: listener 8883, TLS cert/key/CA from
      `/etc/letsencrypt/live/android.spaceworker.top/`, `allow_anonymous false`,
      go-auth plugin config → rc-api. Dev mode: plain 1883 + same auth (compose profile).
- [ ] Prove: `mosquitto_pub -h 127.0.0.1 -p 1883 -u <deviceId> -P <code> -t rc/state/<deviceId> -m '{}'`
      succeeds; wrong password and cross-device topic are denied.
- [ ] ACL test: device `A` cannot publish to `rc/state/B` or subscribe `rc/cmd/B`.

### S4 — rc-relay
- [ ] `ws` server on 8081, path `/relay`; validate `session` + `token` (HMAC, expiry).
- [ ] Pair `role=device` and `role=viewer` by session id; forward binary frames verbatim
      both ways and JSON text both ways.
- [ ] Cache per session: last `0x01` config, last `0x02` key, last `0x04` JPEG; replay to
      a viewer on join (prevents the black-viewer race). Clear on session close.
- [ ] Backpressure: drop `0x03` deltas if the viewer socket is backed up; never drop
      `0x02`/`0x04` silently without updating the cache.
- [ ] Close both sockets on either close; reject a third connection to the same role.

### S5 — rc-web viewer
- [ ] Static page: device list (`/api/devices`), online dot, last seen, agent version,
      **Connect** button, canvas, log pane.
- [ ] Connect → `POST /api/devices/:id/session` → open viewer WSS → send
      `{"t":"hello"}` and `{"t":"viewer.join"}`.
- [ ] **JPEG `0x04` mandatory**: parse the 9-byte header, `Blob` → `createImageBitmap`
      → draw to canvas (fit, preserve aspect).
- [ ] H.264 optional in Phase 1: WebCodecs `VideoDecoder` with `avc1.42E01E`; `0x01`
      config → `configure`, `0x02` key / `0x03` delta → `EncodedVideoChunk`; pts = header
      µs. If not implemented, show "H.264 requires MediaProjection opt-in; using JPEG".
- [ ] Input: pointer down/move/up → `{"t":"touch","action":"down|move|up","nx","ny","pointerId"}`;
      wheel → `scroll`; keyboard → `key`; text field → `text`. Normalize to 0..1.
- [ ] Disconnect button → `POST /api/devices/:id/command {"cmd":"session.stop"}`.

### S6 — Fake-device E2E + unit tests
- [ ] `test/fake-device.mjs`: MQTT connect as `fake-<hex>`, subscribe `rc/cmd/<id>`,
      publish retained `rc/state/<id>`; on `session.start` connect to relay as device,
      send a 1×1 JPEG packed `0x04` and `{"t":"log","msg":"hello"}`; assert the viewer
      receives the JPEG; viewer sends `touch`, fake device receives it.
- [ ] Unit tests: framing pack/unpack (9-byte header), HMAC token (valid/expired/tampered),
      ACL allow/deny, device registry upsert, session TTL.
- [ ] `npm test` + `npm run e2e` green — evidence to `/tmp/t254b_s6.log`.

### S7 — Deploy scripts (STOP for 🚦 owner GO)
- [ ] `deploy/install.sh` (idempotent, `bash -n` first): rsync `android-rc/server` →
      `/opt/android-rc`; create `.env` from `.env.example` **without printing secrets**;
      `docker compose up -d`; systemd unit `android-rc.service` (compose) optional.
- [ ] `deploy/nginx-android.conf`: `android.spaceworker.top` :80 ACME + 301; :443 cert
      `/etc/letsencrypt/live/android.spaceworker.top/`; `/api/` → 8090; `/relay` → 8081
      with Upgrade; `/` → `/opt/android-rc/web`.
- [ ] `deploy/certbot.sh`: `certbot certonly --webroot -w /var/www/certbot -d android.spaceworker.top`.
- [ ] Mosquitto mounts certbot certs read-only; certbot deploy hook restarts mosquitto.
- [ ] `deploy/verify.sh`: `curl -s https://android.spaceworker.top/api/health` → `ok:true`;
      `dig` matches; 8883 TLS handshake (`openssl s_client -connect ...:8883`); regression
      pins `https://spaceworker.top/` = 200, `/login` = 307, vantra + mesh unchanged.
- [ ] **Do not deploy until owner GO.** Back up nginx sites + letsencrypt first.

### S8 — Live verification (after GO)
- [ ] `https://android.spaceworker.top/` loads device list (empty or fake device).
- [ ] Fake device E2E against the deployed stack: appears online; Connect shows a frame;
      touch round-trips.
- [ ] Real phone (owner installs after this): MQTT connects with `https://android.spaceworker.top`
      + fleet code; device appears online; Connect shows the screen; tap works.
- [ ] Record evidence (curl codes, screenshots) in `TASK_254_STEPS.md` T254-B.

---

## 5. Acceptance gates

| Gate | Pass condition |
|---|---|
| B1 build | `npm test` green; `npm run e2e` green locally |
| B2 auth | correct code accepted; wrong code / cross-device topic denied |
| B3 relay | fake device + viewer exchange JPEG frame + touch; key frame replayed to late viewer |
| B4 deploy | `/api/health` 200; 8883 TLS; nginx pins unchanged |
| B5 live | real phone online in viewer; JPEG screen + tap |

---

## 6. Rules / stop conditions

- Never edit `/opt/spaceworker/.env`, `vantra`, `mesh`, or existing nginx configs.
- All box operations via scripts; `bash -n` first; log to `/tmp/t254b_*`.
- Do not deploy or touch DNS without 🚦 owner GO.
- Do not commit secrets, certs, `.env`, or the fleet code.
- Cline leaves changes uncommitted; the senior reviews, gates, commits.
- If go-auth is unstable, switch to EMQX and document it; do not disable auth.

## 7. Out of scope

- T254-C (Spaceworker `AndroidDevice` tables, install page, QR, multi-device broadcast).
- T254-E (factory-reset QR/Device-Owner flow).
- H.264 quality tuning; Phase 1 acceptance is JPEG + input.
