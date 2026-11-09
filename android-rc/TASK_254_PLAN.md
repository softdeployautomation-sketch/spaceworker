# T254-A execution plan (running checklist)

Rule: update before each edit (step + verify command) and after (done + result).

Scope: all work under `android-rc/`; only repo-root exception is `TASK_254_STEPS.md` checkoffs.

## Done
- [x] S1  `android-rc/` created; upstream rc-agent vendored (minus `.git`) at pinned SHA `fb88bd76f4d5b41e30d5cc0263bf49cb0787fdd9`; LICENSE + NOTICE kept; UPSTREAM.md added.
- [ ] S2  `./gradlew testDebugUnitTest` green (BLOCKED: no JDK/Android SDK on host — see notes)
- [x] S3  `applicationId`/`namespace` = `top.spaceworker.rcagent`; targetSdk 35; build defaults `RC_MQTT_BROKER=ssl://android.spaceworker.top:8883`, `RC_WS_BASE=wss://android.spaceworker.top`, `RC_SERVER=https://android.spaceworker.top` (overridable via `-P` / `keystore/keystore.properties`)
- [x] S4  `SpaceworkerEnrollmentActivity` (server URL + enrollment code, or QR scan) — launcher
- [x] S5  Single-screen grant wizard: Accessibility / Notifications / Battery exemption / Overlay; auto-detect + open next missing system setting; primary "Set up & connect"; green when done → "Ready"
- [x] S6  Default capture = Accessibility `takeScreenshot()` JPEG pump (API 30+); MediaProjection/H.264 only behind a settings toggle
- [x] S7  Accessibility gesture input: tap/swipe/type/back/home/recents (upstream `GestureInputEngine` — present)
- [x] S8  `MaintenanceOverlayService` (full-screen branded overlay, optional touch block) + MQTT `maintenance.start` / `maintenance.stop`
- [x] S9  Self-heal (re-enable a11y, reconnect, heartbeat) + Device-Owner first-run `ADMIN_EXTRAS_BUNDLE` parsing (self-heal present upstream)
- [x] S10 `DeviceAdminReceiver` (`AdminReceiver`) + `device_admin.xml` + provisioning metadata; adb fallback documented
- [x] S11 `provision.sh` (adb, idempotent, echoes each step)
- [x] S12 `qr-payload.sh` (provisioning JSON from apk + cert + enroll code; base64url sha256; optional qrencode PNG)
- [x] S13 `README_T254A.md`
- [ ] S14 `assembleRelease` signed APK (artifact path + size) — BLOCKED: no JDK/Android SDK
- [ ] S15 `provision.sh` on test phone; logcat: a11y on, screenshot frame, tap injected — BLOCKED: no adb/phone
- [ ] S16 BYOD onboarding renders + reaches "Ready" — BLOCKED: no adb/phone
- [x] S17 grep: MediaProjection not the default — default path = Accessibility JPEG; MediaProjection only behind Settings toggle
- [x] S18 git status: ZERO changes outside `android-rc/` + `TASK_254_STEPS.md` checkoffs

## Blocked / notes
- No JDK/Android SDK/adb on this host; disk ~3.1GiB free → Gradle toolchain install likely too large/slow. Gradle gates (S2/S14/S15/S16) blocked with unblock steps: install Android SDK + JDK 17, then run `./gradlew testDebugUnitTest` and `./gradlew assembleRelease` inside `android-rc/`; then run `provision.sh` on a connected phone and capture logcat.
- Package-move DONE: all `com/you/rcagent/**` Kotlin sources → `top/spaceworker/rcagent/**` (main + test); package declarations, imports, and `Config.PKG`/`SVC`/`SVC_SHORT` updated to `top.spaceworker.rcagent`.
