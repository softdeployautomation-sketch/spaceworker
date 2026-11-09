#!/usr/bin/env bash
#
# qr-payload.sh — Emit the Android unattended provisioning JSON for rc-agent.
#
# Usage: ./qr-payload.sh <apk> <signing-cert.pem|der> <enrollment-code> [download-url] [out.json]
#
# The QR MUST encode the WHOLE JSON object below (the setup wizard parses it),
# not just the extras bundle. PROVISIONING_ADMIN_EXTRAS_BUNDLE is a nested
# JSON object (not a string). Checksums are base64url(sha256) with no padding:
#   - PACKAGE_CHECKSUM     = sha256(APK bytes)
#   - SIGNATURE_CHECKSUM   = sha256(signing certificate DER)
#
# If `qrencode` is installed, also renders a PNG next to the JSON output.
#
set -euo pipefail

APK="${1:?usage: qr-payload.sh <apk> <signing-cert> <enrollment-code> [download-url] [out.json]}"
CERT="${2:?usage: qr-payload.sh <apk> <signing-cert> <enrollment-code> [download-url] [out.json]}"
ENROLL="${3:?usage: qr-payload.sh <apk> <signing-cert> <enrollment-code> [download-url] [out.json]}"
DOWNLOAD_URL="${4:-https://dl.android.spaceworker.top/android/spaceworker-rc.apk}"
OUT="${5:-/tmp/rc-provisioning.json}"

PKG="top.spaceworker.rcagent"
ADMIN_COMP="$PKG/.AdminReceiver"

RC_SERVER="https://android.spaceworker.top"
RC_WS="wss://android.spaceworker.top"
RC_MQTT="ssl://android.spaceworker.top:8883"

# base64url(sha256(stdin)) with no padding, +/ → -_
b64url_sha256_stdin() {
  openssl dgst -sha256 -binary | base64 | tr -d '\n=' | tr '+/' '-_'
}

if [[ ! -f "$APK" ]]; then
  echo "error: apk not found: $APK" >&2
  exit 1
fi
if [[ ! -f "$CERT" ]]; then
  echo "error: cert not found: $CERT" >&2
  exit 1
fi

APK_SHA="$(b64url_sha256_stdin < "$APK")"

# Accept PEM or DER. For PEM, hash the DER body (not the PEM headers).
if openssl x509 -in "$CERT" -noout >/dev/null 2>&1; then
  CERT_SHA="$(openssl x509 -in "$CERT" -outform DER | b64url_sha256_stdin)"
else
  CERT_SHA="$(b64url_sha256_stdin < "$CERT")"
fi

cat > "$OUT" <<EOF
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "$ADMIN_COMP",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME": "$PKG",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": "$DOWNLOAD_URL",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM": "$APK_SHA",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "$CERT_SHA",
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": true,
  "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
    "rc_server": "$RC_SERVER",
    "rc_enroll": "$ENROLL",
    "rc_ws": "$RC_WS",
    "rc_mqtt": "$RC_MQTT"
  }
}
EOF

cat "$OUT"

if command -v qrencode >/dev/null 2>&1; then
  QR="${OUT%.json}.png"
  # Level M: the full payload is ~700 bytes; level H can exceed capacity.
  qrencode -o "$QR" -l M -s 8 < "$OUT" \
    && echo "QR PNG written to $QR" >&2 \
    || echo "qrencode failed (JSON still valid)" >&2
else
  echo "qrencode not installed; JSON written to $OUT" >&2
fi
