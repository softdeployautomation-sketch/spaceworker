# TASK_254 — Android Agent steps

Rule: update this file **before** each edit (step + verify command) and **after** (done + verify result).

## Senior verification (2026-11-09)
- Source review PASS for S1/S3–S13/S17/S18; `git status` clean outside `android-rc/` + docs.
- **Build/install gates (S2/S14–S16) are BLOCKED on this host** (no JDK/SDK/adb/Docker; 3.2 GiB free).
  Unblock = `.github/workflows/android-build.yml` → push branch → download `spaceworker-rc-apk`.
- Senior fixes applied: `proguard-rules.pro` keep rule, `.gitignore` example template,
  `qr-payload.sh` full-JSON QR + DER cert hash + nested extras object, `AdminReceiver`
  `rc_ws` port parse, onboarding saves enrollment code as MQTT password and treats
  Accessibility as the only blocking grant.
- Full runbook: `SENIOR_T254_ANDROID_VERIFICATION.md`.

## T254-A — Vendor rc-agent + BYOD install-and-run + QR unattended
- [x] S1  Create `android-rc/`, vendor rc-agent at pinned SHA, keep LICENSE/NOTICE, add `UPSTREAM.md`
- [ ] S2  Gradle builds green (`./gradlew testDebugUnitTest`) — BLOCKED: no JDK/Android SDK on host (~3.1GiB free)
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
- [ ] S14 `assembleRelease` signed APK — BLOCKED: no JDK/Android SDK on host
- [ ] S15 Install via `provision.sh` on test phone; logcat: accessibility on, screenshot frame, tap injected — BLOCKED: no adb/phone on host
- [ ] S16 Verify BYOD onboarding renders + reaches "Ready" — BLOCKED: no adb/phone on host
- [x] S17 Verify MediaProjection is not the default (grep) — default path = Accessibility JPEG; MediaProjection only behind Settings toggle
- [x] S18 Confirm no Spaceworker app/lib/prisma files changed — changes confined to `android-rc/` + `TASK_254_STEPS.md`

## T254-B — Backend service (`android-rc/server`)
- [ ] S1  Scaffold service + docker-compose (Mosquitto) + systemd unit + `.env.example`
- [ ] S2  Implement `rc-api` (enroll, heartbeat, device registry, session token)
- [ ] S3  Implement `rc-relay` (WSS pairing, frame/event forwarding, rc-agent protocol)
- [ ] S4  Implement `rc-web` viewer (WebCodecs H.264 + JPEG)
- [ ] S5  Fake-device E2E harness (test frame decodes)
- [ ] S6  Unit tests green

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
