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
| S14 signed APK | **BLOCKED → CI** | host has no JDK/SDK/adb/Docker; 3.2 GiB free |
| S15 install + logcat | **BLOCKED → phone** | no adb/phone on host |
| S16 BYOD "Ready" render | **BLOCKED → phone** | same |
| S17 MediaProjection not default | PASS | grep: only `SessionBus.kt:88` gated path |
| S18 no Spaceworker app/lib/prisma changes | PASS | `git status` changes only under `android-rc/` + docs |

**Verdict:** T254-A is **source-complete, not gate-verified**. Do not mark S2/S14–S16
done until CI produces an APK and it installs on the phone.

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

---

## 4. Blockers and unblock plan

| Blocker | Why | Unblock |
|---|---|---|
| No local Android toolchain | `java -version` fails; `ANDROID_HOME` unset; no `adb`; no Docker; 3.2 GiB free | **CI build** (`android-build.yml`) on GitHub runners; download the APK artifact |
| No adb/phone on host | test phone is physical | owner sideloads `app-debug.apk` (BYOD), or runs `provision.sh` from a machine with adb |
| No release key | Phase 1 | debug keystore generated by `createDebugKeystore`; **production QR needs a stable fleet key** (signature checksum must match) |

CI flow:
```bash
# after commit on task-254-android-agent
git push origin task-254-android-agent
gh run list --workflow android-build.yml --limit 5
gh run watch <run-id>
gh run download <run-id> -n spaceworker-rc-apk -D /tmp/t254-apk
```

---

## 5. Verification protocol per task

### T254-A (APK)
- `cd android-rc && ./gradlew testDebugUnitTest` → BUILD SUCCESSFUL
- `./gradlew createDebugKeystore assembleDebug assembleRelease` → APK paths exist
- `bash -n provision.sh && bash -n qr-payload.sh` → 0
- `grep -rn "MediaProjection" android-rc/app/src/main/kotlin` → only gated path
- `git status --short` → nothing outside `android-rc/` + docs
- Phone: install APK → onboarding → accessibility toggle → "Ready"; `adb logcat -s RC:V`
  shows a11y enabled, screenshot frame, injected tap.

### T254-B (backend)
- Service unit tests green; fake-device E2E: fake client sends a JPEG/H.264 frame,
  viewer decodes; MQTT `session.start`/`stop` round-trip; no listening port on device.
- Protocol must match `android-rc/CLAUDE.md` §"Data plane" (9-byte header, types
  0x01–0x04) and MQTT topics `rc/cmd/<id>`, `rc/state/<id>`, `rc/probe/<id>`, `rc/event/<id>`.

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
1. Commit + push `task-254-android-agent` (T254 files only) → CI builds APK.
2. If CI green: download artifact, owner sideloads, verify S15/S16 → T254-B.
3. If CI red: paste the failing Gradle output into the T254-A2 prompt; fix version/build errors.
