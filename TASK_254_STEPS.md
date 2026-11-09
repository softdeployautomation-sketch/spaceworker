# TASK_254 — Android Agent steps

Rule: update this file **before** each edit (step + verify command) and **after** (done + verify result).

## Senior verification (2026-11-09)
- Source review PASS for S1/S3–S13/S17/S18; `git status` clean outside `android-rc/` + docs.
- **CI build PASS** — run `42585417527` (workflow `android-build.yml`, commit `10177ad`):
  unit tests + debug + release green. Artifact `spaceworker-rc-apk` id `13658214382`.
  - `app-debug.apk` sha256 `e3d66ce5…daec8970` (14 MB, v2/v3 signed, arm64-v8a)
  - `app-release.apk` sha256 `240b6785…ce296504` (12 MB)
- **APK hosted (2026-11-09):**
  - debug `https://spaceworker.top/downloads/android/spaceworker-rc-agent-debug.apk`
    (sha256 `e3d66ce5…daec8970`, HTTP 200, 15,121,132 bytes)
  - release `https://spaceworker.top/downloads/android/spaceworker-rc-agent-release.apk`
  - persistent copies `/opt/android-rc/apk/`; nginx serves from `/opt/spaceworker/public/downloads/android/`.
- **S15/S16 DEFERRED by owner:** install only after the backend/dashboard is live so the
  phone shows as *connected* on first run. Next gate = **T254-B** (see
  `TASK_254B_BACKEND_STEPS.md`). Owner must add DNS `android.spaceworker.top` → `207.244.224.57`.
- Senior fixes applied: `proguard-rules.pro` keep rule, `.gitignore` example template,
  `qr-payload.sh` full-JSON QR + DER cert hash + nested extras object, `AdminReceiver`
  `rc_ws` port parse, onboarding saves enrollment code as MQTT password and treats
  Accessibility as the only blocking grant.
- CI-driven fixes (no local toolchain): `setup-gradle@v4` (wrapper 504), `Config`→`BackendPrefs`
  for MediaProjection, `DevicePolicyManager` extras constant, `raw.toMap()`,
  `onDisableRequested` return type, Activity-context `this` capture, `BuildConfig` import,
  `Row.setGranted`, `view.getChildAt`, `granted()` recursion, Long/Int text color, `Log` import.
- Full runbook: `SENIOR_T254_ANDROID_VERIFICATION.md`.

## T254-A — Vendor rc-agent + BYOD install-and-run + QR unattended
- [x] S1  Create `android-rc/`, vendor rc-agent at pinned SHA, keep LICENSE/NOTICE, add `UPSTREAM.md`
- [x] S2  Gradle builds green (CI run `42585417527`: `testDebugUnitTest` + assemble green)
- [x] S3  Set `applicationId top.spaceworker.rcagent`; build defaults `RC_MQTT_BROKER` / `RC_WS_BASE` / `RC_SERVER`
- [x] S4  Add `SpaceworkerEnrollmentActivity` (server URL + code + QR scan)
- [x] S5  Add single-screen grant wizard (accessibility, notifications, battery, overlay)
- [x] S6  Default capture = Accessibility `takeScreenshot` (API 30+); MediaProjection behind toggle
- [x] S7  Accessibility gesture input (tap/swipe/type/back/home/recents) — upstream `GestureInputEngine` present
- [x] S8  `MaintenanceOverlayService` (`maintenance.start` / `maintenance.stop`, optional touch block)
- [x] S9  Self-heal (re-enable accessibility, reconnect, heartbeat) — upstream `SelfHeal`/`BootReceiver` present
- [x] S10 `DeviceAdminReceiver` + admin extras parsing for QR provisioning
- [x] S11 `provision.sh` (adb grants, idempotent, echoes steps)
- [x] S12 `qr-payload.sh` (emit provisioning JSON from apk + cert + enroll code)
- [x] S13 `README_T254A.md`
- [x] S14 `assembleRelease` signed APK — CI artifact `spaceworker-rc-apk` (debug 14 MB, release 12 MB, v2/v3 signed)
- [ ] S15 Install via `provision.sh` on test phone; logcat: accessibility on, screenshot frame, tap injected — BLOCKED: owner sideload pending (host has no adb/phone)
- [ ] S16 Verify BYOD onboarding renders + reaches "Ready" — BLOCKED: owner sideload pending
- [x] S17 Verify MediaProjection is not the default (grep) — default path = Accessibility JPEG; MediaProjection only behind Settings toggle
- [x] S18 Confirm no Spaceworker app/lib/prisma files changed — changes confined to `android-rc/` + `TASK_254_STEPS.md`

## T254-B — Backend service (`android-rc/server`) — **next; full spec in `TASK_254B_BACKEND_STEPS.md`**
- [ ] S0  Owner: DNS A `android.spaceworker.top` → `207.244.224.57` (DNS-only) + 🚦 GO
- [ ] S1  Scaffold `android-rc/server/` + docker-compose (Mosquitto 8883, api, relay) + `.env.example`
- [ ] S2  `rc-api`: MQTT auth/superuser/ACL endpoints, `/api/devices`, `/api/devices/:id/session`, `/api/devices/:id/command`, `/api/health`; SQLite
- [ ] S3  Mosquitto TLS 8883 + go-auth HTTP backend (fallback EMQX 5); prove auth + per-device ACL
- [ ] S4  `rc-relay`: WSS pairing by session+token, forward frames/JSON, cache last `0x01`/`0x02`/`0x04` for late viewers
- [ ] S5  `rc-web`: device list + connect + JPEG `0x04` canvas + pointer/key/text/scroll input (H.264 optional)
- [ ] S6  Fake-device E2E + unit tests green (`npm test`, `npm run e2e`)
- [ ] S7  Deploy scripts (`install.sh`, nginx vhost, certbot, verify.sh) — **stop for 🚦 GO**
- [ ] S8  Live: `/api/health` 200, 8883 TLS, fake device online, then real phone online + JPEG + tap

## T254-C — Spaceworker integration
- [ ] S1  Additive Prisma: `AndroidDevice`, `AndroidSession`, `AndroidEnrollment`
- [ ] S2  `/api/android/enroll`, `/api/android/devices`, `/api/android/devices/[id]/session`
- [ ] S3  Device page Android rows + install/QR + connect + controls
- [ ] S4  APK hosting `/downloads/android/...` + installer token/QR (Everwas pattern)
- [ ] S5  Multi-device group broadcast
- [ ] S6  Gates: tsc, tests, build, prisma validate

## T254-D — Box deploy (senior)
- [ ] S1  `/opt/android-rc` + systemd + Mosquitto TLS 8883
- [ ] S2  nginx vhost `android.<domain>` + certbot
- [ ] S3  Firewall + relay WSS + APK download
- [ ] S4  Regression pins (spaceworker `/` 200, `/login` 307, vantra, mesh)

## T254-E — Phone E2E (owner + senior)
- [ ] S1  BYOD: install, onboard, enroll, session, video + input
- [ ] S2  QR: factory-reset device, provision as Device Owner, silent grants
- [ ] S3  Cellular + Wi-Fi, TURN evidence
- [ ] S4  Recorded evidence

## T254-F — Overlay + broadcast + audit (Cline)
- [ ] S1  Maintenance overlay live proof
- [ ] S2  Multi-device broadcast live proof
- [ ] S3  Audit rows for sessions/commands
