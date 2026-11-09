# T254-A — Android Agent (rc-agent vendored)

Vendored [rc-agent](https://github.com/ytruongdang/rc-agent) (Apache-2.0), adapted for Spaceworker.
All work lives under `android-rc/`; no Spaceworker app/lib/prisma files are touched.

- **Repo:** https://github.com/ytruongdang/rc-agent
- **Pinned commit:** `fb88bd76f4d5b41e30d5cc0263bf49cb0787fdd9` (see `UPSTREAM.md`)
- **License:** Apache-2.0 (`LICENSE` + `NOTICE` kept verbatim)
- **Package:** `top.spaceworker.rcagent` | **minSdk 26** | **targetSdk 35**

## Build

Requires the Android SDK + JDK (17). This host has neither (blocked — see "Gates" below).

```sh
cd android-rc
./gradlew createDebugKeystore
./gradlew assembleDebug
./gradlew testDebugUnitTest
./gradlew assembleRelease
```

### Signing / keystore

`keystore/`, `build/`, and `local.properties` are gitignored — no secrets committed. `keystore/keystore.properties.example` shows the expected format. `createDebugKeystore` generates `keystore/debug.keystore` for Phase-1. For production, add `keystore/fleet.jks` + `keystore/keystore.properties` (`FLEET_*` values).

### Build defaults (overridable)

| Property | Default | Override |
|---|---|---|
| `RC_MQTT_BROKER` | `ssl://android.spaceworker.top:8883` | `-P RC_MQTT_BROKER=...` / `keystore.properties` |
| `RC_WS_BASE` | `wss://android.spaceworker.top` | `-P RC_WS_BASE=...` |
| `RC_SERVER` | `https://android.spaceworker.top` | `-P RC_SERVER=...` |

## BYOD install-and-run (PRIORITY)

1. Build/sign the APK (`assembleRelease` → `app/build/outputs/apk/release/app-release.apk`).
2. Host the APK on your download page.
3. User installs the APK (allows "install from unknown source").
4. User opens the app → **SpaceworkerEnrollmentActivity** (single screen):
   - server URL + enrollment code, or QR scan
   - checklist: Accessibility, Notifications, Battery exemption, Overlay
   - one "Set up & connect" button opens the next missing system setting, in order
   - rows auto-detect already-granted (turn green)
   - all-green → enroll + connect → **"Ready"**, zero further prompts

After onboarding:
- Capture default = `AccessibilityService.takeScreenshot()` (API 30+) JPEG pump — **no MediaProjection prompt**.
- MediaProjection / H.264 only behind the Settings toggle "Allow MediaProjection / H.264" (opt-in).
- Input = Accessibility gestures (tap/swipe/type/back/home/recents).

## provision.sh (USB/ADB bootstrap)

Idempotent; echoes each step:

```sh
./provision.sh /path/to/app-release.apk
```

1. `adb install -r <apk>`
2. `adb shell pm grant <pkg> android.permission.WRITE_SECURE_SETTINGS`
3. `adb shell settings put secure enabled_accessibility_services <pkg>/<Service>`
4. `adb shell settings put secure accessibility_enabled 1`
5. `adb shell pm grant <pkg> android.permission.POST_NOTIFICATIONS`
6. `adb shell appops set <pkg> SYSTEM_ALERT_WINDOW allow`
7. `adb shell dumpsys deviceidle whitelist +<pkg>`

## QR unattended provisioning (Device Owner)

On a factory-reset device, the user scans a QR at setup. The system downloads the APK, verifies APK + signature checksums, sets the app as Device Owner, and delivers `PROVISIONING_ADMIN_EXTRAS_BUNDLE`.

```sh
./qr-payload.sh app-release.apk release-cert.pem <enrollment-code> \
    https://dl.android.spaceworker.top/android/spaceworker-rc.apk
```

Prints JSON (`PROVISIONING_DEVICE_ADMIN_*` + `PROVISIONING_ADMIN_EXTRAS_BUNDLE`); if `qrencode` is installed, also renders a PNG. `AdminReceiver` parses the bundle (`rc_server`, `rc_enroll`, `rc_ws`, `rc_mqtt`) on first enable and connects MQTT silently.

ADB fallback: `adb shell dpm set-device-owner top.spaceworker.rcagent/.AdminReceiver`

## Maintenance overlay

`MaintenanceOverlayService` shows a full-screen branded overlay ("Maintenance in progress") with optional touch blocking, toggled by MQTT commands `maintenance.start` / `maintenance.stop`. Requires `SYSTEM_ALERT_WINDOW`.

## Self-heal

`SelfHeal` re-enables accessibility + reconnects MQTT after OTA / process kill; `BootReceiver` runs it on boot / package replace. MQTT heartbeat every 2 minutes.

## Permissions (what each is for)

| Permission | Purpose |
|---|---|
| `INTERNET` | MQTT + WebSocket to relay/backend |
| `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PROJECTION` | Keep capture alive during sessions |
| `SYSTEM_ALERT_WINDOW` | Maintenance overlay (full-screen) |
| `RECEIVE_BOOT_COMPLETED` | Self-heal on boot |
| `WAKE_LOCK` / `TURN_SCREEN_ON` | Keep screen on during sessions |
| `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | Network diagnostics |
| `POST_NOTIFICATIONS` | Keep process alive (foreground service channel) |
| `USE_FULL_SCREEN_INTENT` | Projection prompt full-screen intent |
| `WRITE_SECURE_SETTINGS` | Self-heal: re-enable accessibility (ADB/Device-Owner only) |
| `DEVICE_ADMIN` / `MANAGE_DEVICE_ADMINS` | QR unattended Device-Owner provisioning |
| `com.samsung.android.knox.permission.KNOX_REMOTE_CONTROL` | Optional Knox input (compileOnly, absent at runtime) |
| `BIND_ACCESSIBILITY_SERVICE` | Declared on `RcAccessibilityService` (system binds it) |
| `BIND_DEVICE_ADMIN` | Declared on `AdminReceiver` (system binds it) |

## Gates

| Gate | Command | Status |
|---|---|---|
| Unit tests | `./gradlew testDebugUnitTest` | blocked (no JDK/Android SDK on host) |
| Signed release APK | `./gradlew assembleRelease` | blocked (same) |
| Phone install + logcat | `./provision.sh` then logcat | blocked (no adb/phone on host) |
| BYOD "Ready" | install + onboard | blocked (same) |
| MediaProjection not default | `grep` source | runnable |
| No Spaceworker files changed | `git status` | runnable |

See `TASK_254_PLAN.md` for the running step checklist (S1–S18) and `TASK_254_STEPS.md` (repo root) for cross-checks.

