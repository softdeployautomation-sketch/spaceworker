# Contributing

Thanks for taking an interest. This is a small, production-focused codebase; the
notes below are what will save you the most time.

## Before you start

- **Open an issue first** for anything beyond a bug fix. The agent runs unattended
  on real devices, so a change that looks like a cleanup can take a fleet offline.
- If you are touching framing, MQTT payloads, or the WebSocket handshake, say so
  in the issue. Those are a shared contract with a server this repository does not
  contain, and a one-sided change breaks both ends.

## Development setup

You need JDK 17 and an Android SDK with API 36. Android Studio is optional;
everything below works from a terminal.

```bash
./gradlew testDebugUnitTest      # JVM tests, no device needed
./gradlew assembleDebug
./gradlew installDebug
adb logcat -s RC:V
```

Running a single test:

```bash
./gradlew testDebugUnitTest --tests '*FramingTest*'
./gradlew testDebugUnitTest --tests '*FramingTest.detectsIdrNal'
```

You do **not** need a signing keystore to build debug or run tests. You cannot
build a release APK without one, and that is deliberate.

## What a good patch looks like

**Put the logic where a JVM test can reach it.** The code is structured so that
framing, resolution ladders, congestion, capability fingerprints, MDM key
flattening and consent labels are all decidable without an Android device. If
your change needs an emulator to verify, that is usually a sign the decision
should move out of the Android class.

**Change the test first** when you change classification behaviour. `FramingTest`
in particular pins real encoder quirks — QCOM omitting `BUFFER_FLAG_KEY_FRAME`,
WebRTC prepending SPS/PPS — and a test failure there is far more likely to be a
regression than a stale expectation.

**Route recoverable failures through `SessionBus.fail(code, msg)` or
`SessionDiag.fail`**, with a short uppercase code (`H264_INIT`,
`PROJECTION_DENIED`, `MP_READER`, …). That single call reaches MQTT, the viewer
log and the on-disk breadcrumb at once. Logging and returning means a device
fails silently in a car park, which is the failure mode this project exists to
avoid.

**Wrap anything OEM-specific in `runCatching`.** The fleet must stay reachable
over MQTT even when a capture path is completely broken. An agent that streams
nothing is a nuisance; an agent that cannot be reached needs a van.

**Never commit a credential, hostname or keystore.** Endpoints come from Gradle
properties (`RC_MQTT_BROKER`, `RC_WS_BASE`, `RC_MQTT_PASSWORD`) and MDM, never
from source. See [SECURITY.md](SECURITY.md).

## Style

- Sources live in `app/src/main/kotlin/…`, not `java/`.
- Comments are sparse and exist to record hard-won device quirks, several of them
  in Vietnamese. Keep that style: **explain the quirk, not the code.** A comment
  saying *"QCOM throws Wrong thread if initEncode runs off the capture thread"* is
  worth ten that restate the line below them.
- Follow the surrounding code's naming and formatting. `kotlin.code.style=official`.

## Commit messages

Write the subject as what the change accomplishes and why it matters, in one
line, present tense — the existing history is the reference:

```
Keep MQTT alive after an rc-cap SurfaceTexture crash instead of hanging main on stopCapture.
Init and encode H.264 on the SurfaceTextureHelper thread so QCOM does not throw Wrong thread.
```

## Pull requests

- `./gradlew testDebugUnitTest` must pass; CI runs it on every PR.
- Say which device and Android version you tested on, if any. "Untested on
  hardware" is an acceptable answer and much better than silence.
- One logical change per PR.

## Licence

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), as per section 5 of that licence.
