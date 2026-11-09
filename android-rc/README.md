# RC Agent

[![CI](https://github.com/ytruongdang/rc-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ytruongdang/rc-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![minSdk](https://img.shields.io/badge/minSdk-26-brightgreen.svg)](app/build.gradle.kts)

**Open-source remote screen control for Android devices, built to plug into
[Headwind MDM](https://h-mdm.com/).**

Headwind MDM gives you an inventory of your devices and the ability to push apps
and settings to them. What it does not give you is a live screen. RC Agent adds
that: install it as a managed app, fill in five Application Settings, and any
device in the fleet can be viewed and driven from a browser — screen streamed as
H.264, touches and keys injected back.

It is aimed at unattended devices: kiosks, parking terminals, vending machines,
digital signage. Nobody is standing at the device to tap "Start now" on a
permission dialog, reboot something that wedged, or read a stack trace, so most
of this codebase is about **recovering without a human** and about leaving enough
evidence on disk that a failure which killed the process can still be explained
afterwards.

> **Scope.** This is fleet tooling. It needs `WRITE_SECURE_SETTINGS`, an
> accessibility service and a provisioned MQTT credential — it is installed by an
> administrator onto devices that administrator owns, and it does not try to
> hide: it registers a launcher icon and shows a notification while capturing.
> See [SECURITY.md](SECURITY.md).

## How the pieces fit

```
   ┌────────────────┐   app + Application Settings   ┌──────────────────┐
   │  Headwind MDM  │ ─────────────────────────────▶ │  Android device  │
   │    server      │        (APK, config push)      │   ┌──────────┐   │
   └────────────────┘                                │   │ RC Agent │   │
                                                     │   └────┬─────┘   │
   ┌────────────────┐        MQTT: session.start     │        │         │
   │  rc-api        │ ───────────────────────────────┼────────┘         │
   │  rc-relay      │                                │                  │
   │  rc-ingest     │ ◀──── WebSocket: H.264 / JPEG ─┼───── screen      │
   │  rc-web        │ ─────────────────────────────▶ │ ───▶ touch/keys  │
   └───────┬────────┘                                └──────────────────┘
           │ browser
      ┌────▼────┐
      │ operator│
      └─────────┘
```

Headwind MDM handles **deployment and configuration**. A separate backend
(`rc-api`, `rc-relay`, `rc-ingest`, `rc-web`) handles **sessions and the viewer**.
This repository is the **device-side agent** — the part that runs on Android.

The backend is not included here. The MQTT topics and the WebSocket frame format
are specified below in enough detail to write one — the agent is a WebSocket
client and opens no listening port of its own, so the relay is the piece you
supply.

## Headwind MDM integration

### 1. Add the app

Build a release APK (see [Release builds](#release-builds)) and upload it in
Headwind under **Applications → Add**, then include it in the configuration
assigned to your devices. Package name is `com.you.rcagent`.

### 2. Configure it

In Headwind, open the app entry and add **Application Settings**. These are the
keys the agent reads:

| Key | Example | Meaning |
| --- | --- | --- |
| `host` | `https://relay.yourdomain.net` | Backend / relay host |
| `mqtt` | `mqtts://relay.yourdomain.net:8883` | Broker URI. Blank follows `host` |
| `mqtt_password` | *(your broker password)* | MQTT password. The **username is the device id** |
| `device_id` | `%SERIAL%` | MQTT client id. Blank falls back to `ANDROID_ID` |
| `relay_port` | `0` | WebSocket port. Blank or `0` means 443 (wss) / 3001 (ws) |

Headwind's `%SERIAL%` placeholder is expanded by Headwind before the agent sees
it, so setting `device_id` to `%SERIAL%` gives every device a stable, meaningful
MQTT identity without configuring them one by one.

Aliases are accepted for each key — `backend`, `relay_host`, `mqtt_broker`,
`mqtt_pass`, `deviceId`, `ws_port` — because different Headwind setups and
older configurations name them differently.
[`ManagedConfig.flatten`](app/src/main/kotlin/com/you/rcagent/mdm/ManagedConfig.kt)
is the canonical mapping and is unit-tested.

### 3. Grant the permissions

The agent needs two things Headwind is well placed to give it:

- **`WRITE_SECURE_SETTINGS`** — used by
  [`SelfHeal`](app/src/main/kotlin/com/you/rcagent/boot/SelfHeal.kt) to re-enable
  its own accessibility service. Samsung One UI silently switches accessibility
  services off after an OTA or an app update, and on an unattended device nobody
  notices until a session fails. Grant it once over adb, or from Headwind if your
  devices are provisioned as device owner:
  ```bash
  adb shell pm grant com.you.rcagent android.permission.WRITE_SECURE_SETTINGS
  ```
- **Accessibility service** — enable *RC Agent* under Settings → Accessibility on
  first install. After that `SelfHeal` keeps it enabled by itself.

On Samsung devices, Knox `RemoteInjection` is used for input when available;
Headwind activates the Knox licence, and the agent only reflects into the SDK
(the jar is `compileOnly` and is not redistributed here). Without Knox it falls
back to accessibility gesture dispatch, which works but is slower.

### How the config actually arrives

Two independent paths, both funnelling into `ManagedConfig`:

1. **Headwind AIDL bridge** —
   [`HeadwindBridge`](app/src/main/kotlin/com/you/rcagent/mdm/HeadwindBridge.kt)
   binds `com.hmdm.action.Connect` on `com.hmdm.launcher` (falling back to the
   legacy `ru.headwind.kiosk`) and calls `queryAppPreference(packageName, key)`
   for each key above. It re-pulls on the `com.hmdm.push.configUpdated`
   broadcast, so a settings change in the Headwind console reaches the device
   without reinstalling anything, and it re-binds with backoff if the launcher
   restarts. The AIDL interface is vendored at
   [`IMdmApi.aidl`](app/src/main/aidl/com/hmdm/IMdmApi.aidl).
2. **Standard Android managed restrictions** —
   [`app_restrictions.xml`](app/src/main/res/xml/app_restrictions.xml), applied
   on `ACTION_APPLICATION_RESTRICTIONS_CHANGED`. **This means the agent also
   works under any other EMM** that supports managed configurations — Headwind is
   the first-class path, not the only one.

When either path changes something, the agent reconnects MQTT immediately rather
than waiting for the next heartbeat.

Headwind's `runApp` push can also be used as a wake path: it fires
`com.you.rcagent.WAKE`, which takes a wakelock and forces an MQTT reconnect for a
device that has gone quiet.

### Checking it worked

Launch **RC Agent** from the home screen. `SettingsActivity` is a diagnostics
dump, not a real UI: it shows the resolved host, MQTT state, which capability
flags are set, the live encoder name, and the last MDM keys applied. For local
development you can type the same values by hand in *Connection settings*
instead of going through an MDM.

```bash
adb logcat -s RC:V     # every log in the app uses TAG "RC"
```

## Quick start

```bash
git clone https://github.com/ytruongdang/rc-agent.git
cd REPO
./gradlew testDebugUnitTest     # JVM unit tests — no device, no emulator
./gradlew assembleDebug         # debug APK (cleartext allowed)
./gradlew installDebug
```

The decision logic is deliberately kept out of Android classes — framing,
resolution ladders, congestion, capability fingerprints, MDM key flattening,
consent labels — so `testDebugUnitTest` covers it on a plain JVM. If you are
changing behaviour, there is usually a test to change first.

`assembleRelease` is intentionally harder: see [Release builds](#release-builds).

## Build-time defaults

**No endpoint or credential is hardcoded in this repository.** The committed
defaults are placeholders (`relay.example.com`, empty password), because in a
real deployment Headwind supplies them. If you want a build that points at your
own infrastructure out of the box, use Gradle properties — in
`~/.gradle/gradle.properties`, in a gitignored `keystore/keystore.properties`, on
the command line, or from a CI secret:

```properties
RC_MQTT_BROKER=ssl://relay.yourdomain.net:8883
RC_WS_BASE=wss://relay.yourdomain.net
RC_MQTT_PASSWORD=
RC_DEVICE_ID=
```

```bash
./gradlew assembleRelease -PRC_MQTT_BROKER=ssl://relay.yourdomain.net:8883
```

Precedence at runtime is `BuildConfig` defaults → `SharedPreferences("rc")` → MDM.
**MDM wins**, because the fleet is configured centrally.

Prefer pushing `mqtt_password` from Headwind over baking it into the APK. A
release build refuses to connect to MQTT with an empty password, and refuses
cleartext URIs outright (`Config.permitsUri`); debug builds relax both through a
manifest overlay and `network_security_config`.

### WAN vs LAN

`Config.wan` is derived from whether the configured host is a public address, and
it silently changes resolution caps, bitrate, frame rate, JPEG quality and
congestion thresholds. **When a stream looks fine at one site and wrong at
another, check this first.** It is the most common source of "it works on my
desk".

## Architecture

### Lifecycle

`RcApplication.onCreate` is the entire bootstrap: install the crash handler, run
`SelfHeal`, apply MDM config, bind Headwind, start MQTT. There is no
launcher-driven startup path. The device boots, and the agent is simply there.

`AgentState.Phase` (`HEALING → IDLE → RECONNECTING/ACQUIRING → STREAMING`) is the
one global phase, and components read it to decide whether to act: `BootReceiver`
refuses to self-heal mid-session, `AutoConsent` only clicks while `ACQUIRING`.

### Control plane — MQTT

Paho v5, client id = device id, topics all suffixed with it:

| Topic | Direction | Payload |
| --- | --- | --- |
| `rc/cmd/<id>` | subscribe | `probe`, `selfheal`, `session.start` (`wsUrl` + `token`), `session.stop` |
| `rc/state/<id>` | publish, retained, QoS 1 | capabilities + telemetry; LWT publishes `online:false` |
| `rc/probe/<id>` | publish | one-shot answer to `probe` |
| `rc/event/<id>` | publish | failure events |

Two behaviours are load-bearing and easy to break:

- Retained state is delayed by `CapsSync.waitForA11y`, so the backend never
  stores `a11y=false` captured during accessibility-service bind.
- Heartbeats only re-publish the full retained state when the capability
  fingerprint actually changes.

`CommandHandler.rewriteLanHost` rewrites `localhost` / `127.0.0.1` inside an
incoming `wsUrl`, because the backend publishes its own view of the relay URL and
that view is not the device's.

### Data plane — WebSocket framing

Every media frame is a **9-byte header** followed by an Annex-B or JPEG payload:

```
 0        1                                   9
 +--------+-----------------------------------+------------------ ...
 | type   | pts, microseconds, big-endian u64 | payload
 +--------+-----------------------------------+------------------ ...

 type 0x01  config (SPS/PPS)
      0x02  key frame
      0x03  delta frame
      0x04  JPEG
```

The viewer decodes Baseline `avc1.42E01E` with WebCodecs. Do **not** introduce
High profile, VP8/VP9, or a different header without changing the server and the
viewer at the same time.

Frame type is **not** taken from `MediaCodec`'s flags. QCOM encoders omit
`BUFFER_FLAG_KEY_FRAME`, and WebRTC's encoder prepends SPS/PPS to every key
frame, so `Framing.typeOfH264` resolves the type from the NAL types themselves.
`FramingTest` pins those cases — change the test first.

[SessionSocket](app/src/main/kotlin/com/you/rcagent/transport/SessionSocket.kt)
holds the first key frame and any JSON until the socket is genuinely open, then
flushes. *A black viewer is almost always an IDR that was sent before `onOpen`.*
It also drops delta frames that depend on discarded NALs, and runs
`Congestion.tick` off `WebSocket.queueSize()` to steer bitrate.

### Capture paths, in preference order

1. **WebRTC hardware H.264** —
   [WebRtcH264Encoder](app/src/main/kotlin/com/you/rcagent/capture/WebRtcH264Encoder.kt).
   `ScreenCapturerAndroid` must be the one to call `getMediaProjection`, because
   the token is one-shot; and `initEncode` must run on the same
   `SurfaceTextureHelper` thread (`rc-cap`) that later delivers frames, or QCOM
   throws *"Wrong thread"*.
2. **MediaProjection + ImageReader JPEG** —
   [MpJpegPump](app/src/main/kotlin/com/you/rcagent/capture/MpJpegPump.kt), when
   H.264 init fails or the kill switch is set.
3. **Accessibility `takeScreenshot` JPEG** —
   [ScreenshotPump](app/src/main/kotlin/com/you/rcagent/capture/ScreenshotPump.kt),
   with *no* foreground service, because Samsung and Headwind kill a
   `mediaProjection` FGS. This is the path when projection is denied or times out.

`CaptureService.jpegFallback` degrades between them mid-session, reusing the live
`MediaProjection` rather than re-prompting.

> **Never** attach a `VirtualDisplay` to an app-owned
> `MediaCodec.createInputSurface()`. That combination SIGSEGVs on QCOM, and it is
> the whole reason path 1 goes through WebRTC instead of raw `MediaCodec`.

`Encoder.startWithFallback` walks a resolution ladder (`Encoder.ladderFor` —
never the native panel size), and `SessionBus.dropLadderAndRestart` lowers the
ceiling after a failure.

### Surviving native kills

Nobody is watching the device, so failures are *recorded* rather than observed.

- [FaultLog](app/src/main/kotlin/com/you/rcagent/core/FaultLog.kt) `fsync`s a
  one-line breadcrumb **before** each risky call. On the next process start, a
  breadcrumb with no matching Java stack is reported as `KILLED` — that is how a
  native crash or an FGS kill gets attributed at all.
- [HwKillSwitch](app/src/main/kotlin/com/you/rcagent/capture/HwKillSwitch.kt)
  reads those breadcrumbs: a `KILLED` during H.264 init or run permanently sets
  `skip_hw_h264` for that device, so it boots straight to JPEG instead of
  crash-looping.
- [CapCrash](app/src/main/kotlin/com/you/rcagent/capture/CapCrash.kt): a crash on
  the `rc-cap` thread must never be joined on — waiting for that dead Looper
  deadlocks main and takes MQTT down with it, which is how a device goes silent.
  The uncaught handler detects this, marks abandon, and recovers on main.
- [SessionDiag](app/src/main/kotlin/com/you/rcagent/core/SessionDiag.kt) mirrors
  the same events as `{"t":"log"}` JSON on the viewer socket, with a replayed
  backlog on connect, so a black session is diagnosable from the web UI without
  adb access to a device in a car park.

### Consent and input

Media projection normally needs a human tap.
[AutoConsent](app/src/main/kotlin/com/you/rcagent/capture/AutoConsent.kt) drives
the system dialog through the accessibility service, matching English and
Vietnamese labels and explicitly rejecting the "single app" and cancel buttons.
It only runs while a session is pending. If the dialog never resolves, a 20s
timeout in `SessionBus` falls through to the accessibility JPEG path.

Input goes through `InputEngine`: Samsung Knox `RemoteInjection` (reflection
only), or a gesture-dispatch fallback. `SessionBus.pickInput` prefers Knox.
Losing accessibility mid-stream keeps the video up and only drops input.

## Release builds

```bash
./gradlew assembleRelease
```

This **fails by design** unless `keystore/fleet.jks` exists. A debug-signed APK
pushed through Headwind breaks updates on every device at once, and there is no
way to recover except by physically touching each one. The keystore and
`keystore/keystore.properties` are gitignored; see
[keystore/keystore.properties.example](keystore/keystore.properties.example).

Bump `versionCode` and `versionName` together (`1.4.5` ↔ `10405`). Headwind uses
`versionCode` to decide whether to push an update; `versionName` is reported in
every MQTT state payload and in on-disk crash breadcrumbs, and a version change
wipes stale breadcrumbs on next launch.

## Contributing

Bug reports and patches are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Comments in this codebase are sparse and exist to record hard-won device quirks,
several of them in Vietnamese. Keep that style: explain the quirk, not the code.

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Y Truong.
Third-party components are listed in [NOTICE](NOTICE).

Headwind MDM is a trademark of its respective owners; this project is an
independent integration and is not affiliated with or endorsed by them.
