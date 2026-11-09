# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`RCAgent` (`com.you.rcagent`) — the Android side of UKPC Remote Control. It is an unattended agent installed on a fleet of kiosk/parking devices (Samsung + Headwind MDM). It listens on MQTT for a `session.start`, grabs the screen, streams H.264 (or JPEG) over a WebSocket to the relay, and injects touch/keys from the viewer. There is no user at the device, so most of the complexity is *recovering without a human*.

The server counterpart (`rc-api`, `rc-relay`, `rc-ingest`, `rc-web`) is a separate, non-public codebase. The wire protocol below is shared with it — changing framing or MQTT payloads means changing both.

## Commands

```bash
./gradlew testDebugUnitTest                              # JVM unit tests (no device needed)
./gradlew testDebugUnitTest --tests '*FramingTest*'      # one test class
./gradlew testDebugUnitTest --tests '*FramingTest.detectsIdrNal'   # one test method
./gradlew assembleDebug                                  # debug APK (cleartext allowed)
./gradlew assembleRelease                                # signed fleet APK
./gradlew installDebug
adb logcat -s RC:V                                       # every log in the app uses TAG "RC"
```

`assembleRelease` deliberately fails if `keystore/fleet.jks` is missing (see the `taskGraph.whenReady` guard in [app/build.gradle.kts](app/build.gradle.kts)) — a debug-signed APK pushed to the fleet would break updates on every device. The keystore and `keystore/keystore.properties` are gitignored.

Bump `versionCode`/`versionName` together in [app/build.gradle.kts](app/build.gradle.kts) (`1.4.5` ↔ `10405`); `versionName` is reported in every MQTT state payload and in on-disk crash breadcrumbs, and a version change wipes stale breadcrumbs on next launch.

## Architecture

### Lifecycle

`RcApplication.onCreate` is the whole bootstrap: install the crash handler, `SelfHeal.run` (re-enable our accessibility service via `WRITE_SECURE_SETTINGS`, keep screen on while charging), apply MDM config, bind Headwind, start MQTT. There is no launcher-driven startup path — `SettingsActivity` is a diagnostics dump, not the entry point.

`AgentState.Phase` (HEALING → IDLE → RECONNECTING/ACQUIRING → STREAMING) is the single global phase. Many components read it to decide whether to act (e.g. `BootReceiver` refuses to self-heal mid-session, `AutoConsent` only clicks while ACQUIRING).

### Control plane — MQTT

[transport/MqttClient.kt](app/src/main/kotlin/com/you/rcagent/transport/MqttClient.kt), Paho v5, client id = `deviceId`. Topics, all suffixed with the device id:

- `rc/cmd/<id>` (subscribe) — `probe`, `selfheal`, `session.start` (`wsUrl` + `token`), `session.stop`
- `rc/state/<id>` (retained, QoS 1) — caps + volatile telemetry; LWT publishes `online:false`
- `rc/probe/<id>`, `rc/event/<id>` — one-shot answers and failure events

Two subtleties worth preserving: retained state is delayed by `CapsSync.waitForA11y` so the backend never stores `a11y=false` during service bind, and heartbeats only re-publish full retained state when the caps fingerprint changes. `CommandHandler.rewriteLanHost` rewrites `localhost`/`127.0.0.1` in `wsUrl` to the configured host, because the backend publishes its own view of the relay URL.

### Data plane — WebSocket framing

[transport/Framing.kt](app/src/main/kotlin/com/you/rcagent/transport/Framing.kt): every media frame is a 9-byte header (1 byte type + 8 byte pts µs big-endian) followed by an Annex-B or JPEG payload. Types: `0x01` config (SPS/PPS), `0x02` key, `0x03` delta, `0x04` JPEG. The viewer decodes Baseline `avc1.42E01E` with WebCodecs, so **do not** introduce high profile, VP8/VP9, or a different header.

Type classification is not `MediaCodec`'s flags: QCOM omits `BUFFER_FLAG_KEY_FRAME`, and WebRTC's encoder prepends SPS/PPS to every key frame. `Framing.typeOfH264` resolves this from the NAL types themselves — `FramingTest` pins the cases, change it there first.

[transport/SessionSocket.kt](app/src/main/kotlin/com/you/rcagent/transport/SessionSocket.kt) holds the first key frame and any JSON until the socket is actually open, then flushes it — a black viewer is usually an IDR sent before `onOpen`. It also drops deltas that depend on discarded NALs, and runs `Congestion.tick` off `WebSocket.queueSize()` to steer bitrate (thresholds are tighter on WAN).

### Capture paths, in preference order

1. **WebRTC hardware H.264** — [WebRtcH264Encoder](app/src/main/kotlin/com/you/rcagent/capture/WebRtcH264Encoder.kt) + [MpWebrtcCapturer](app/src/main/kotlin/com/you/rcagent/capture/MpWebrtcCapturer.kt). `ScreenCapturerAndroid` must be the one to call `getMediaProjection` (the token is one-shot), and `initEncode` must run on the same `SurfaceTextureHelper` thread (`rc-cap`) that later delivers frames or QCOM throws "Wrong thread".
2. **MediaProjection + ImageReader JPEG** — [MpJpegPump](app/src/main/kotlin/com/you/rcagent/capture/MpJpegPump.kt), used when H.264 init fails or the kill switch is set.
3. **Accessibility `takeScreenshot` JPEG** — [ScreenshotPump](app/src/main/kotlin/com/you/rcagent/capture/ScreenshotPump.kt) + [SessionCapture](app/src/main/kotlin/com/you/rcagent/capture/SessionCapture.kt), with *no* foreground service, because Samsung/Headwind kill a `mediaProjection` FGS. This is the path when projection is denied or times out.

`CaptureService.jpegFallback` degrades between them mid-session and reuses the live `MediaProjection` where possible rather than re-prompting.

Never attach a `VirtualDisplay` to an app-owned `MediaCodec.createInputSurface()` — that combination SIGSEGVs on QCOM and is the reason path 1 goes through WebRTC. `Encoder.startWithFallback` walks a resolution ladder (`Encoder.ladderFor`, never native panel size) and `SessionBus.dropLadderAndRestart` lowers the ceiling after a failure.

### Surviving native kills

The device has no operator, so failures are recorded rather than observed:

- [FaultLog](app/src/main/kotlin/com/you/rcagent/core/FaultLog.kt) `fsync`s a one-line breadcrumb *before* each risky call. On next process start, a breadcrumb with no matching Java stack is reported as `KILLED` — that's how a native crash or an FGS kill is attributed.
- [HwKillSwitch](app/src/main/kotlin/com/you/rcagent/capture/HwKillSwitch.kt) reads those breadcrumbs: a `KILLED` during H.264 init/run permanently sets `skip_hw_h264` for that device, so it boots straight to JPEG.
- [CapCrash](app/src/main/kotlin/com/you/rcagent/capture/CapCrash.kt): a crash on the `rc-cap` thread must not be joined on — waiting for that dead Looper deadlocks main and kills MQTT. The uncaught handler detects it, marks abandon, and recovers on the main thread instead of letting the process die.
- [SessionDiag](app/src/main/kotlin/com/you/rcagent/core/SessionDiag.kt) mirrors the same events as `{t:"log"}` JSON on the viewer socket (with a replayed backlog on connect), so a black session can be diagnosed from rc-web without adb.

### Consent and input

Media projection normally needs a tap. [AutoConsent](app/src/main/kotlin/com/you/rcagent/capture/AutoConsent.kt) drives the system dialog through the accessibility service, matching English and Vietnamese labels and explicitly rejecting "single app"/cancel buttons; it only runs while a session is pending. If the dialog never resolves, `SessionBus`'s 20s timeout falls through to the accessibility JPEG path.

Input is `InputEngine` with two implementations: Knox `RemoteInjection` (reflection only — the SDK jar is compileOnly and absent from the repo; the MDM pre-activates the license) and a gesture-dispatch fallback. `SessionBus.pickInput` prefers Knox; losing accessibility mid-stream keeps the video up and only drops input.

### Configuration precedence

`BuildConfig` defaults → `BackendPrefs` in SharedPreferences `"rc"` → MDM. The `BuildConfig` defaults themselves come from Gradle properties (`RC_MQTT_BROKER`, `RC_WS_BASE`, `RC_MQTT_PASSWORD`, `RC_DEVICE_ID`), read from a gitignored `keystore/keystore.properties` or `-P`; this repo is public, so the committed defaults are placeholders and there is **no** fallback password in source. MDM arrives two ways, both funnelling into [ManagedConfig](app/src/main/kotlin/com/you/rcagent/mdm/ManagedConfig.kt): Android managed restrictions ([app_restrictions.xml](app/src/main/res/xml/app_restrictions.xml)) and the Headwind AIDL bridge ([HeadwindBridge](app/src/main/kotlin/com/you/rcagent/mdm/HeadwindBridge.kt), [IMdmApi.aidl](app/src/main/aidl/com/hmdm/IMdmApi.aidl)). Keys are `host`, `mqtt`, `mqtt_password`, `device_id`, `relay_port`, each with Headwind-style aliases; `ManagedConfig.flatten` is the canonical mapping and is unit-tested.

`Config.wan` is derived from whether the configured host is a public address, and it silently changes resolution caps, bitrate, fps, JPEG quality and congestion thresholds. When a stream looks wrong at one site and fine at another, check this first.

Release builds refuse cleartext (`Config.permitsUri`) and refuse to connect to MQTT without a password; debug builds allow both via a manifest overlay and `network_security_config`.

## Conventions

- Source is `app/src/main/kotlin/...`, not `java/`. Tests are plain JUnit on the JVM — the code is deliberately structured so the decision logic (framing, ladders, congestion, caps fingerprints, MDM flattening, consent labels) is testable without a device.
- Comments are sparse and exist to record hard-won device quirks; several are in Vietnamese. Keep that style: explain the quirk, not the code.
- Recoverable failures go through `SessionBus.fail(code, msg)` / `SessionDiag.fail` with a short uppercase code (`H264_INIT`, `PROJECTION_DENIED`, `MP_READER`, …) so they reach MQTT, the viewer log and the on-disk breadcrumb at once. Don't just log and return.
- `runCatching` around anything OEM-specific; the fleet must stay reachable even when a capture path is broken.
- Never commit a hostname, credential or keystore. Endpoints are build properties (above); `keystore/keystore.properties.example` documents them.
