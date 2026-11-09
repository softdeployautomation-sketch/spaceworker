## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What failed on a device, or what it makes possible. -->

## Checklist

- [ ] `./gradlew testDebugUnitTest` passes
- [ ] No credential, hostname or keystore added to the repository
- [ ] Recoverable failures go through `SessionBus.fail` / `SessionDiag.fail` with a short uppercase code
- [ ] OEM-specific calls are wrapped in `runCatching`
- [ ] If framing / MQTT payloads / the WS handshake changed, the server counterpart is covered

## Tested on

<!-- Device and Android version, or "not tested on hardware". -->
