#!/usr/bin/env bash
#
# provision.sh — BYOD/Device-Owner bootstrap via USB+ADB. Idempotent; echoes each step.
#
# Usage: ./provision.sh [path/to/app-release.apk]
#
# Grants (in order):
#   1. adb install -r <apk>
#   2. pm grant WRITE_SECURE_SETTINGS
#   3. settings put secure enabled_accessibility_services <pkg>/<svc>
#   4. settings put secure accessibility_enabled 1
#   5. pm grant POST_NOTIFICATIONS
#   6. appops set <pkg> SYSTEM_ALERT_WINDOW allow
#   7. dumpsys deviceidle whitelist +<pkg>
#
set -euo pipefail

APK="${1:-}"
PKG="top.spaceworker.rcagent"
SVC="$PKG/$PKG.input.RcAccessibilityService"

step() { echo "==> $*"; }
ok()   { echo "     [ok] $*"; }

require_adb() {
  if ! command -v adb >/dev/null 2>&1; then
    echo "error: adb not found on PATH" >&2
    return 1
  fi
  if ! adb get-state >/dev/null 2>&1; then
    echo "error: no device/emulator reachable via adb" >&2
    return 1
  fi
}

main() {
  require_adb

  step "Verify device"
  adb get-state | sed 's/^/     /'
  ok "device reachable"

  if [[ -n "$APK" ]]; then
    if [[ ! -f "$APK" ]]; then
      echo "error: apk not found: $APK" >&2
      exit 1
    fi
    step "Install APK: $APK"
    adb install -r "$APK" | sed 's/^/     /'
    ok "installed $PKG"
  else
    step "Skip install (no apk given); assuming $PKG already present"
  fi

  step "Grant WRITE_SECURE_SETTINGS"
  adb shell pm grant "$PKG" android.permission.WRITE_SECURE_SETTINGS | sed 's/^/     /'
  ok "WRITE_SECURE_SETTINGS"

  step "Enable accessibility service: $SVC"
  adb shell settings put secure enabled_accessibility_services "$SVC" | sed 's/^/     /'
  ok "enabled_accessibility_services=$SVC"

  step "Set accessibility_enabled=1"
  adb shell settings put secure accessibility_enabled 1 | sed 's/^/     /'
  ok "accessibility_enabled=1"

  step "Grant POST_NOTIFICATIONS"
  adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS | sed 's/^/     /'
  ok "POST_NOTIFICATIONS"

  step "Allow SYSTEM_ALERT_WINDOW (overlay)"
  adb shell appops set "$PKG" SYSTEM_ALERT_WINDOW allow | sed 's/^/     /'
  ok "SYSTEM_ALERT_WINDOW=allow"

  step "Add to deviceidle whitelist"
  adb shell dumpsys deviceidle whitelist +"$PKG" | sed 's/^/     /'
  ok "deviceidle whitelist +$PKG"

  step "Provisioning complete"
  echo "     pkg=$PKG"
  echo "     svc=$SVC"
}

main "$@"
