# PLAN_TASK_254 — Android Agent (rc-agent fork) + Spaceworker integration

## 0. Status / decision
- Base: **rc-agent** (`ytruongdang/rc-agent`, Apache-2.0), vendored under `android-rc/`.
- **Priority 1 (BYOD):** user installs the APK, runs it, completes ONE guided setup screen, then screen view + input work with **zero further prompts**.
- **Priority 2 (Unattended QR):** on a factory-reset device, a QR provisions the APK as **Device Owner** and grants everything silently.
- Supersedes `PLAN_TASK_235_ANDROID_REMOTE_CONTROL.md` / `TASK_235_ANDROID_SERVER_STEPS.md` (dead host `164.68.105.96`, upstream `h-mdm/apuppet-android` 404). Keep TASK_235 as history.

## 1. Why rc-agent
Modern Kotlin (minSdk 26), purpose-built for unattended fleets:
- MQTT control plane + H.264/JPEG over WebSocket (agent is a WS client; opens no listening port).
- MediaProjection **and** Accessibility `takeScreenshot()` fallback (silent capture on API 30+).
- Gesture input via Accessibility; Samsung Knox input support.
- AutoConsent for MediaProjection; self-heal after OTA / process kill.
- Backend not included → we build it into our stack (no premium paywall, our auth/DB).

## 2. Android reality (accepted)
| Grant | BYOD | Device Owner (QR) |
|---|---|---|
| Install from unknown source | 1 toggle | automatic |
| Accessibility service | 1 toggle (+ "Allow restricted settings" on 13+) | automatic |
| Notification / battery / overlay | 1 tap each, chained on one screen | automatic |
| Screen capture | **silent** via Accessibility `takeScreenshot()` (API 30+) | silent |
| High-FPS MediaProjection | optional, AutoConsent | optional |
| Input injection | silent (Accessibility gestures) | silent |
| WRITE_SECURE_SETTINGS | only via `adb` bootstrap | automatic |

**Honest maximum:** BYOD = 1 install toggle + 1 accessibility toggle on one guided screen; after that, zero prompts. True zero-touch = Device Owner QR (requires factory reset).

## 3. Architecture
```
APK (top.spaceworker.rcagent)
 ├ Accessibility: input + silent screenshots (default)
 ├ MediaProjection: optional H.264 (toggle)
 ├ MaintenanceOverlay (SYSTEM_ALERT_WINDOW)
 ├ DeviceAdminReceiver (QR / Device-Owner provisioning)
 └ MQTT control + WSS media client (no listening port)

Box 207.244.224.57 → /opt/android-rc (own systemd unit; never inside /opt/spaceworker)
 ├ Mosquitto 8883 TLS
 ├ rc-relay WSS 443 (operator ⇄ device pairing, frame forwarding)
 ├ rc-api (enroll / heartbeat / session-token)
 └ rc-web (WebCodecs H.264 + JPEG viewer)

nginx android.<domain> → relay/api/viewer + APK download
Spaceworker → AndroidDevice/AndroidSession (additive Prisma), device page,
             APK installer + QR (mirrors Everwas link flow), controls, audit
```

## 4. Two provisioning paths

### 4.1 BYOD (normal install)
Download APK → allow install → open → one screen "Set up & connect" → chains Accessibility / notifications / battery / overlay → enrolls → "Ready".
- Capture default = Accessibility `takeScreenshot()` (no per-session prompt).
- Input = Accessibility gestures.
- MediaProjection/H.264 is opt-in (settings toggle) for high FPS.

### 4.2 Unattended (QR, factory-reset device)
Device scans QR at setup; system downloads APK, verifies checksum + signature, sets Device Owner, delivers admin extras.
```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "top.spaceworker.rcagent/.AdminReceiver",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME": "top.spaceworker.rcagent",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": "https://dl.<domain>/android/spaceworker-rc.apk",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM": "<base64url-sha256(apk)>",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "<base64url-sha256(signing-cert)>",
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": true,
  "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
    "rc_server": "https://android.<domain>",
    "rc_enroll": "<enrollment-code>",
    "rc_ws": "wss://android.<domain>",
    "rc_mqtt": "ssl://android.<domain>:8883"
  }
}
```
Spaceworker generates this QR per enrollment (Task C/D), like the Everwas install command.

## 5. Spaceworker integration surface
- `prisma/schema.prisma` — additive `AndroidDevice`, `AndroidSession`, `AndroidEnrollment`.
- `app/api/android/*` — enroll, devices, session token, commands.
- `app/api/devices/route.ts` + device page — Android rows and controls.
- `app/link/vantra/[token]/route.ts` pattern + `lib/vantra-link.ts` — APK installer token/QR.
- No changes to the Everwas flow.

## 6. Tasks
| ID | Owner | Scope | Gate |
|---|---|---|---|
| T254-A | Cline | Vendor rc-agent; BYOD onboarding; QR/Device-Owner support; accessibility-screenshot default; maintenance overlay; `provision.sh`; signed APK | Gradle gates, install on phone, logcat proof |
| T254-B | Cline | Backend service (Mosquitto + relay + api + viewer), exact rc-agent protocol | Unit + fake-device E2E |
| T254-C | Cline | Spaceworker Prisma/APIs/UI + APK host + QR generator | tsc, tests, build, prisma validate |
| T254-D | Senior | Box deploy + nginx + certbot + systemd + regression pins | Endpoints 200, MQTT TLS, pins |
| T254-E | Owner + Senior | Phone E2E (BYOD + QR) | Recorded evidence |
| T254-F | Cline | Maintenance overlay + multi-device broadcast + audit, live proof | Live demo |

## 7. Risks
- Play Protect flags sideloaded remote-control APKs → distribute via our download page / MDM.
- Accessibility blocked on some OEMs without "Allow restricted settings".
- MediaProjection consent on non-Device-Owner devices.
- QR signature checksum must match a **stable release key** (debug key is for Phase 1 only).

## 8. Verification protocol
Each task: Cline leaves changes uncommitted on a branch → senior runs gates, reviews diffs, captures evidence, commits with attribution, merges; deploy only after 🚦 owner GO. Box ops via scripts; additive migrations only; nginx regression pins after any vhost change.
