# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions track `versionName` in [app/build.gradle.kts](app/build.gradle.kts).

## [1.4.6]

### Added
- `isAccessibilityTool="true"` on the accessibility service. Since Android 14 a
  view can mark itself accessibility-data-sensitive, and such nodes are withheld
  from services that do not declare this. The media-projection consent dialog is
  a plausible candidate, and `AutoConsent` would simply stop seeing its buttons.
- A `PROJECTION_FALLBACK` event when consent times out and the session continues
  on the accessibility JPEG path. That branch previously recovered in silence, so
  a fleet-wide loss of auto-consent would have shown up only as "everything looks
  blurry lately".

### Changed
- First public release. Backend endpoints and the MQTT password moved out of
  source into Gradle properties (`RC_MQTT_BROKER`, `RC_WS_BASE`,
  `RC_MQTT_PASSWORD`); the published defaults are placeholders, and there is no
  fallback password in source — an unconfigured release build refuses to connect.
- `jvmTarget` moved to the `compilerOptions` DSL, which Kotlin 2.4 requires.
- Toolchain: Kotlin 2.4.20, Gradle 9.7.1.

## [1.4.5]

### Added
- Session and encoder stats streamed as `{"t":"log"}` JSON on the viewer
  WebSocket, so a black session can be diagnosed without adb.
- Vector launcher icon that survives round and squircle masks.

### Fixed
- MQTT survives an `rc-cap` SurfaceTexture crash instead of hanging main
  thread on `stopCapture`.

## [1.4.0]

### Added
- WebRTC `HardwareVideoEncoder` H.264 capture path with a JPEG fallback ladder.
- Crash breadcrumbs (`FaultLog`) and a per-device hardware H.264 kill switch.
