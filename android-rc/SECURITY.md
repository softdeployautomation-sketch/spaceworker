# Security

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue.

Use GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on this repository. If that is unavailable to you, open a normal
issue that says only that you have a security report and asks for a contact — do
not include details.

Please include what you can: affected version (`versionName`), device model and
Android version, and the steps to reproduce. Expect an initial response within a
few working days. This is a small project; there is no bug bounty.

## What this software is

RC Agent gives a remote operator a live view of an Android device's screen and
the ability to inject touch and key events. That is, by design, a very high level
of access. It is intended for **device fleets that the operator owns and
administers** — kiosks, parking terminals, signage — and its deployment model
reflects that:

- It is installed and configured by an MDM, not from an app store.
- It cannot function without an accessibility service that the user (or, in
  practice, `WRITE_SECURE_SETTINGS` on a device the administrator provisioned)
  has enabled.
- It requires `WRITE_SECURE_SETTINGS`, which is a privileged permission only
  granted to system apps or over adb by someone with physical access.
- It will not connect without an MQTT credential that the administrator supplies.
- It shows a foreground-service notification while capturing, and it registers a
  launcher icon. It does not attempt to hide.

Do not deploy it on devices you do not administer, and do not deploy it on
devices used by people who have not been told it is there. Depending on your
jurisdiction, covert deployment on someone else's device is a criminal offence.
The Apache-2.0 licence grants no exception to that.

## No credentials in this repository

Endpoints and the broker password are build-time inputs, not source:
`RC_MQTT_BROKER`, `RC_WS_BASE`, `RC_MQTT_PASSWORD`. The defaults committed here
are placeholders (`relay.example.com`, empty password). Supply real values from a
gitignored `keystore/keystore.properties`, `~/.gradle/gradle.properties`, `-P`
flags, or a CI secret.

The fleet signing keystore (`keystore/fleet.jks`) and `keystore.properties` are
gitignored and have never been committed. `assembleRelease` fails without them
rather than silently producing a debug-signed APK.

If you fork this project, generate your own keystore and your own broker
credentials. Do not reuse anything from an upstream build.

## Transport

Release builds refuse cleartext URIs (`Config.permitsUri`) and refuse to connect
to MQTT with an empty password. Debug builds relax both, via a manifest overlay
and `network_security_config`, so that a laptop broker on a LAN is usable during
development. **Do not ship a debug build to real devices.**

Session authorisation is a per-session token issued by the backend and passed in
the `session.start` payload; the agent forwards it as a query parameter on the
relay WebSocket. Tokens are short-lived and are not persisted.

## Supported versions

Only the latest release receives security fixes.
