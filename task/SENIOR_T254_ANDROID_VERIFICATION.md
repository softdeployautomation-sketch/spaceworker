# SENIOR T254 — Android Agent verification runbook

**Purpose:** this is the senior-verification contract for the Android agent work
(T254). If the current senior stops, the next senior reads this file, then
`PLAN_TASK_254_ANDROID_AGENT.md` + `TASK_254_STEPS.md`, and continues without
re-deriving anything. Update this file in place at the end of every T254 session.

**Owner decisions (locked 2026-11-09):**
- Base: `ytruongdang/rc-agent` (Apache-2.0), vendored under `android-rc/`.
- **Priority 1:** BYOD — install APK, run it, one guided setup screen, then zero further prompts.
- **Priority 2:** QR unattended — factory-reset device scans QR → APK installed as Device Owner, all grants silent.
- Backend: new `/opt/android-rc` service on `207.244.224.57` (Mosquitto + relay + api + viewer).
- Test phone: existing phone, normal install (attended) for Phase 1.

---

## 1. Where things live

| Item | Value |
|---|---|
| Repo | `/Users/mikeolab/spaceworker` |
| Working branch | `task-254-android-agent` (created off `main` `b363fa5`) |
| Android source | `android-rc/` (vendored; 644K) |
| Upstream pin | `ytruongdang/rc-agent` @ `fb88bd76f4d5b41e30d5cc0263bf49cb0787fdd9` (`android-rc/UPSTREAM.md`) |
| App id | `top.spaceworker.rcagent` |
| Plan | `PLAN_TASK_254_ANDROID_AGENT.md` |
| Checklist | `TASK_254_STEPS.md` |
| CI | `.github/workflows/android-build.yml` (new; builds debug + debug-signed release APK) |
| Remotes | `origin` = `softdeployautomation-sketch/spaceworker`; `michael-fork` = `Mikeolab/spaceworker` |
| Box | `207.244.224.57` (old `164.68.105.96` dead) |
| Deploy | CI from `main` only; `gh workflow run 'Build & Deploy' -R softdeployautomation-sketch/spaceworker` |

---

## 2. Current status (2026-11-09)

| Gate | Status | Evidence |
|---|---|---|
| S1 vendored + LICENSE/NOTICE/UPSTREAM | PASS | `android-rc/UPSTREAM.md`, `LICENSE`, `NOTICE` |
| S3 applicationId + build defaults | PASS | `android-rc/app/build.gradle.kts` (`applicationId`, `RC_*` buildConfigFields) |
| S4 onboarding activity | PASS (source) | `android-rc/app/src/main/kotlin/top/spaceworker/rcagent/onboarding/SpaceworkerEnrollmentActivity.kt` |
| S5 grant wizard | PASS (source) | same file; accessibility-only blocking after senior fix |
| S6 accessibility-screenshot default | PASS | `core/SessionBus.kt:86-88`, `capture/ScreenshotPump.kt:49` |
| S7 gesture input | PASS (upstream) | `input/GestureInputEngine` present |
| S8 maintenance overlay | PASS (source) | `capture/MaintenanceOverlayService.kt` |
| S9 self-heal | PASS (upstream) | `core/SelfHeal`, `boot/BootReceiver` |
| S10 DeviceAdmin + extras | PASS (source; fixed mapping) | `mdm/AdminReceiver.kt` |
| S11 provision.sh | PASS (`bash -n`) | `android-rc/provision.sh` |
| S12 qr-payload.sh | PASS (`bash -n`; rewritten) | `android-rc/qr-payload.sh` |
| S13 README | PASS | `android-rc/README_T254A.md` |
| S2 reproducible build | **PASS (CI)** | run `42585417527` green: unit tests + debug + release |
| S14 signed APK | **PASS (CI)** | `app-debug.apk` 14 MB, `app-release.apk` 12 MB; v2/v3 signing block present; arm64-v8a |
| S15 install + logcat | **DEFERRED — backend first** | owner decision 2026-11-09: install only after the dashboard is live |
| S16 BYOD "Ready" render | **DEFERRED — backend first** | same |
| S17 MediaProjection not default | PASS | grep: only `SessionBus.kt:88` gated path |
| S18 no Spaceworker app/lib/prisma changes | PASS | `git status` changes only under `android-rc/` + docs |

**Verdict:** T254-A is **built, signed, and hosted**. S15/S16 are deliberately deferred:
the owner wants the backend + dashboard live first so the phone shows as *connected*
immediately after install. T254-B (`TASK_254B_BACKEND_STEPS.md`) is the next gate.

Build evidence:
- Workflow run `42585417527` (`android-build.yml`, `task-254-android-agent` @ `10177ad`).
- Artifact `spaceworker-rc-apk` id `13658214382`, 15,526,784 bytes.
- `app-debug.apk` sha256 `e3d66ce534571df8e107f7cb18ac63139ffc64d4ff9ebbe2510ed856daec8970`
- `app-release.apk` sha256 `240b678591854c9da5866e28b253b3bbb9ac0630857702536bfa03fece296504`
- Manifest verified (UTF-16 string pool): package `top.spaceworker.rcagent`,
  `SpaceworkerEnrollmentActivity`, `MaintenanceOverlayService`, `AdminReceiver`,
  `BIND_ACCESSIBILITY_SERVICE` all present. versionName `1.0.0-t254a`, versionCode 1,
  minSdk 26 / targetSdk 35. Native ABI: **arm64-v8a only** (by design, `abiFilters`).

### 2.1 APK hosting (2026-11-09)

Uploaded to the box and served by the existing nginx `location /downloads/` rule
(`root /opt/spaceworker/public`):

- Debug (use this one): `https://spaceworker.top/downloads/android/spaceworker-rc-agent-debug.apk`
  — HTTP 200, `application/octet-stream`, 15,121,132 bytes, sha256 matches `e3d66ce5…daec8970`.
- Release: `https://spaceworker.top/downloads/android/spaceworker-rc-agent-release.apk`
  — 12,183,231 bytes, sha256 matches `240b6785…ce296504`.

Persistent copies live at `/opt/android-rc/apk/` (the `public/downloads` copy can be
wiped by a future deploy that rsyncs the repo with `--delete`). Re-copy if the link 404s.

### 2.2 Client ↔ backend contract (verified from source)

- MQTT broker default is `ssl://android.spaceworker.top:8883` (`BuildConfig.MQTT_BROKER`);
  the onboarding "Server URL" field **does not** change it. Deploy at that hostname.
- MQTT username = `deviceId` (`ANDROID_ID`), password = the enrollment code the user
  types. Client id = `deviceId`. MQTT 5, LWT retained `rc/state/<id>` `{"online":false}`.
- The current APK **never calls an HTTP enroll endpoint** — the code is used directly as
  the MQTT password. Phase 1 auth = one rotatable fleet code + per-username ACL.
- Topics: `rc/cmd/<id>`, `rc/state/<id>`, `rc/probe/<id>`, `rc/event/<id>`.
- Session: server publishes `session.start` with `wsUrl` + `token`; device appends
  `?token=…` and connects. Frames = 9-byte header (type + pts µs BE) + payload;
  `0x01` config, `0x02` key, `0x03` delta, `0x04` JPEG. Default capture is **JPEG**.
- Viewer input JSON: `hello`, `viewer.join`, `touch|pointer` (`action`, `nx`, `ny`,
  `pointerId`), `key`, `text`, `scroll`.
- `wsBase` derives from the saved host + relay port; the server can hand any `wsUrl`.

### 2.3 T254-B — deployed and verified (B4 PASS)

`android.spaceworker.top` (DNS → `207.244.224.57`, owner-created) is live:
`https://android.spaceworker.top/api/health` → `ok:true`; 8883 TLS handshake OK;
regression pins OK; viewer at `https://android.spaceworker.top/` loads.
Local E2E: 18/18 unit tests pass, fake-device E2E all pass.
Deploy method (host loopback docker-proxy is broken on this box): `mosquitto` via
`docker run --network host`; `api` + `relay` as host processes (`node api/index.mjs`,
`node relay/index.mjs`); nginx vhost proxies `127.0.0.1:8090/8081`. See
`TASK_254B_BACKEND_STEPS.md` S7.

---

## 3. Defects found by senior review and fixed (2026-11-09)

| # | File | Defect | Fix |
|---|---|---|---|
| 1 | `android-rc/app/proguard-rules.pro:1` | keep rule still `com.you.rcagent.**` after package move → R8 would strip/obfuscate app classes in release | changed to `top.spaceworker.rcagent.**` |
| 2 | `android-rc/.gitignore` | blanket `keystore/` ignored `keystore.properties.example` → template never committed | removed blanket dir ignore; kept `*.jks/*.keystore/*.p12/keystore.properties`; added `!keystore/keystore.properties.example` |
| 3 | `android-rc/qr-payload.sh` | QR rendered from the **extras bundle only**, not the full provisioning JSON; cert hash was over PEM bytes (not DER); extras bundle embedded as an escaped **string** instead of a nested **object** | rewrote: full JSON to `$OUT`, DER-normalised cert hash, nested object, QR rendered from full JSON, level M |
| 4 | `android-rc/app/src/main/kotlin/top/spaceworker/rcagent/mdm/AdminReceiver.kt` | `rc_ws` (a URL) mapped to `ws_port` (an Int) → silently dropped | parse `java.net.URI(rc_ws).port`; set `ws_port` only when 1..65535 |
| 5 | `android-rc/app/src/main/kotlin/top/spaceworker/rcagent/onboarding/SpaceworkerEnrollmentActivity.kt` | enrollment code saved to unused `rc_enroll` prefs → MQTT auth never got it; all four grants blocked "Ready" | save code via `BackendPrefs.saveMqttPassword`; **accessibility is the only blocking grant**, others optional |

**Known risk (unproven):** upstream pins **AGP 8.9.1 + Gradle 9.7.1 + Kotlin 2.4.20**
(`android-rc/build.gradle.kts`, `gradle/wrapper/gradle-wrapper.properties`). AGP 8.9.1
officially pairs with Gradle 8.11.1. If CI fails on the AGP/Gradle check, pin the
wrapper to 8.11.1 (or bump AGP) and record it here.

**Stale doc:** `android-rc/CLAUDE.md` still says package `com.you.rcagent` and that
release requires `fleet.jks`; the vendored build allows a debug-signed release for
Phase 1. Update CLAUDE.md when the fleet key lands.

### 3.1 CI build fixes (2026-11-09, senior)

The first real compile on CI surfaced defects that local review could not catch
(no JDK/SDK on host). All fixed:

| # | File | Defect | Fix |
|---|---|---|---|
| 6 | `.github/workflows/android-build.yml` | wrapper download 504s + cache-key churn on every `build.gradle.kts` edit | replaced `actions/cache` + `./gradlew` with `gradle/actions/setup-gradle@v4` (`gradle-version: 8.11.1`) and `gradle` commands |
| 7 | `core/SessionBus.kt:88`, `settings/SettingsActivity.kt:84-86` | `Config.mediaProjectionEnabled` / `Config.saveMediaProjection` unresolved — functions live in `BackendPrefs` | call `BackendPrefs.*` (same package in `SessionBus`; imported in `SettingsActivity`) |
| 8 | `mdm/AdminReceiver.kt` | `DeviceAdminReceiver.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE` does not exist | `DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE` |
| 9 | `mdm/AdminReceiver.kt:38,71` | `Map(raw)` — `Map` is an interface, no constructor | `raw.toMap()` |
| 10 | `mdm/AdminReceiver.kt:49` | `onDisableRequested` returned `Boolean`; base class returns `CharSequence?` | return `CharSequence?` (`null` = allow disable) |
| 11 | `onboarding/SpaceworkerEnrollmentActivity.kt:52,58,69,88,94` | `TextView(this)` inside `LinearLayout(this).apply { }` captured the layout, not the Activity | `TextView(this@SpaceworkerEnrollmentActivity)` |
| 12 | `onboarding/SpaceworkerEnrollmentActivity.kt:108` | `BuildConfig` unresolved in `onboarding` package | `import top.spaceworker.rcagent.BuildConfig` |
| 13 | `onboarding/SpaceworkerEnrollmentActivity.kt:141` | `row.view.setGranted(...)` — `setGranted` is on `Row`, not `LinearLayout` | `row.setGranted(...)` |
| 14 | `onboarding/SpaceworkerEnrollmentActivity.kt:280-282` | bare `getChildAt` inside `Row` | `view.getChildAt(...)` |
| 15 | `onboarding/SpaceworkerEnrollmentActivity.kt:285` | `fun granted() = granted()` recursed into itself (ctor param shadowed) | renamed ctor param to `check`, `fun granted() = check()` |
| 16 | `onboarding/SpaceworkerEnrollmentActivity.kt:281` | `setTextColor(if (ok) 0xFF00C853 else -1)` — Long/Int mismatch | `0xFF00C853.toInt()` |
| 17 | `settings/SettingsActivity.kt:87` | `Log` used without import | `import android.util.Log` |

Commit chain: `fb24a1a` (setup-gradle), `0f888e6` (Kotlin fixes), `10177ad` (Long/Int + Log).

---

## 4. Blockers and unblock plan

| Blocker | Why | Unblock |
|---|---|---|
| No local Android toolchain | `java -version` fails; `ANDROID_HOME` unset; no `adb`; no Docker; 3.2 GiB free | **RESOLVED** — CI builds green (run `42585417527`) |
| No backend / dashboard | was missing; **now deployed** at `android.spaceworker.top` | **RESOLVED** — B4 PASS (`/api/health`, 8883 TLS, pins) |
| DNS `android.spaceworker.top` | was missing; **owner created** A record → `207.244.224.57` | **RESOLVED** — `dig +short` returns `207.244.224.57` |
| MQTT auth | client sends username=`deviceId`, password=enrollment code; Mosquitto static `password_file` cannot do dynamic users | go-auth HTTP backend → `rc-api` (approved fallback: EMQX 5 HTTP authn/authz) |
| No adb/phone on host | test phone is physical | **deferred by owner** until the dashboard is live, then owner sideloads `app-debug.apk` |
| No release key | Phase 1 | debug keystore generated by `createDebugKeystore`; **production QR needs a stable fleet key** (signature checksum must match) |

CI flow (working as of 2026-11-09):
```bash
git push origin task-254-android-agent
gh run list --workflow android-build.yml --limit 5
gh run watch <run-id> --exit-status
# NOTE: `gh run download` timed out on this host; pull the zip via API instead:
AID=$(gh api repos/softdeployautomation-sketch/spaceworker/actions/runs/<run-id>/artifacts \
  --jq '.artifacts[] | select(.name=="spaceworker-rc-apk") | .id')
gh api repos/softdeployautomation-sketch/spaceworker/actions/artifacts/$AID/zip > /tmp/t254-apk.zip
unzip -o /tmp/t254-apk.zip -d /tmp/t254-apk
# → /tmp/t254-apk/debug/app-debug.apk, /tmp/t254-apk/release/app-release.apk
```

---

## 5. Verification protocol per task

### T254-A (APK)
- CI: `android-build.yml` → unit tests + `createDebugKeystore` + `assembleDebug` +
  `assembleRelease` all green (run `42585417527`). Host cannot run Gradle locally.
- `bash -n provision.sh && bash -n qr-payload.sh` → 0
- `grep -rn "MediaProjection" android-rc/app/src/main/kotlin` → only gated path
- `git status --short` → nothing outside `android-rc/` + docs
- Phone (owner, pending): install `/tmp/t254-apk/debug/app-debug.apk` → onboarding →
  accessibility toggle → "Ready"; `adb logcat -s RC:V` shows a11y enabled, screenshot
  frame, injected tap. Without adb: Settings → Accessibility → RC Agent; app UI must
  render the four grant rows with Accessibility green and "Ready".
- Expected install friction: Play Protect warning on sideload; accept "Install anyway".
  The APK is debug-signed and arm64-v8a only.

### T254-B (backend)
- `npm test` + `npm run e2e` green locally; fake device sends a JPEG `0x04` frame with
  the 9-byte header and the viewer receives it; viewer `touch` reaches the device.
- MQTT auth: correct fleet code accepted, wrong code and cross-device topic denied.
- Relay: late viewer receives the cached `0x01` config + `0x02` key / `0x04` JPEG.
- Deployed: `https://android.spaceworker.top/api/health` → `ok:true`; 8883 TLS
  handshake; `https://android.spaceworker.top/` lists the fake device online.
- Real phone: install after the above; MQTT connects with `https://android.spaceworker.top`
  + fleet code; device appears online; Connect shows the screen; tap works.

### T254-C (Spaceworker)
- `npx tsc --noEmit`; `npm test`; `npm run build`; `npx prisma validate`
- Additive migration only; no changes to Everwas flow; device list still 200.

### T254-D (box)
- `/opt/android-rc` systemd active; Mosquitto 8883 TLS; WSS handshake; APK download 200.
- Regression pins: `curl -s -o /dev/null -w '%{http_code}' https://spaceworker.top/` = 200;
  `/login` = 307; vantra + mesh unchanged.
- 🚦 owner GO before deploy.

### T254-E (phone E2E)
- BYOD: install → onboard → enroll → session → video + input.
- QR: factory-reset device → scan → Device Owner → silent grants.
- Cellular + Wi-Fi; TURN candidate evidence.

### T254-F (overlay/broadcast/audit)
- `maintenance.start` shows overlay; `maintenance.stop` removes it.
- Broadcast command reaches N devices; audit rows written.

---

## 6. Rules (do not break)
- Never `git stash`; never edit `.env`; never commit keystores/secrets.
- All box operations via scripts; `bash -n` first; log to `/tmp`.
- Additive Prisma migrations only.
- Do not push `main`; deploy only after 🚦 owner GO.
- Cline leaves changes uncommitted; senior reviews, gates, commits with attribution.
- Only write in `SENIOR_HANDOFF.md` what was verified this session.

---

## 7. Next action
**T254-B is deployed and verified (B4 PASS).** `https://android.spaceworker.top/api/health` → `ok:true`; 8883 TLS handshake OK; regression pins OK. The fake device E2E passed locally (18/18 unit tests, fake-device E2E all pass).

1. **Owner:** install `https://spaceworker.top/downloads/android/spaceworker-rc-agent-debug.apk`
   (debug only — do not install the release APK), onboard to `https://android.spaceworker.top`
   with the fleet enrollment code (out-of-band, never committed), grant Accessibility.
   The device must appear **online** in `https://android.spaceworker.top/`; Connect shows
   the screen; tap works. This closes B5/S15/S16.
2. Then **T254-C** (Spaceworker install page/QR, mirroring `app/link/vantra/[token]/route.ts`),
   `npx tsc --noEmit`; `npm test`; `npm run build`; `npx prisma validate`; additive
   migration only; no changes to Everwas flow.
3. Then **T254-D/T254-E/T254-F** per sections above.

**Fleet enrollment code (out-of-band, never committed):** generated 64-hex code. Provide it to the owner separately for APK onboarding.
