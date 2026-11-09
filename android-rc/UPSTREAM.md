# Upstream vendored source — rc-agent

This directory (`android-rc/`) vendors **rc-agent** (Apache-2.0), adapted for Spaceworker.

- Repo: https://github.com/ytruongdang/rc-agent
- Pinned commit: `fb88bd76f4d5b41e30d5cc0263bf49cb0787fdd9` (main)
- License: Apache-2.0 (see `LICENSE` + `NOTICE`, kept verbatim)

## What changed vs upstream
- `applicationId` / `namespace`: `com.you.rcagent` → `top.spaceworker.rcagent`
- `targetSdk`: 36 → 35 (compileSdk kept at 35)
- Build-config defaults changed from `relay.example.com` placeholders to
  `RC_MQTT_BROKER=ssl://android.spaceworker.top:8883`,
  `RC_WS_BASE=wss://android.spaceworker.top`,
  `RC_SERVER=https://android.spaceworker.top` — overridable via Gradle
  properties (`-P RC_MQTT_BROKER=...`) or `keystore/keystore.properties`.
- Added `SpaceworkerEnrollmentActivity` (BYOD one-screen onboarding), QR-scan
  entry, grant-wizard row auto-detect, default Accessibility `takeScreenshot()`
  capture with MediaProjection opt-in toggle, `MaintenanceOverlayService`,
  `AdminReceiver` Device-Owner provisioning, `provision.sh`, `qr-payload.sh`.
- `keystore/`, `build/`, `local.properties` are gitignored (no secrets committed).

See `README_T254A.md` for build/sign/BYOD/QR instructions.
