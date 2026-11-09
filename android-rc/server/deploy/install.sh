#!/usr/bin/env bash
# deploy/install.sh — idempotent install of android-rc server to /opt/android-rc
# T254-B: run only after 🚦 owner GO. Never prints secrets except the one-time
# fleet enrollment code, which the owner must type into the APK onboarding.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="/opt/android-rc"
ENV_EXAMPLE="$SRC/.env.example"
ENV_FILE="$DST/.env"

log() { echo "[install] $*"; }

# 1. bash -n syntax check on this script first
bash -n "$0" || { echo "[install] FATAL: bash -n failed"; exit 1; }

# 2. rsync server tree (exclude generated .env, node_modules, sqlite data)
log "rsync $SRC -> $DST"
mkdir -p "$DST"
rsync -a --delete --exclude='.env' --exclude='node_modules' --exclude='data' --exclude='*.sqlite' "$SRC/" "$DST/"

# 3. Generate /opt/android-rc/.env with real secrets (never committed to git)
if [ ! -f "$ENV_FILE" ]; then
  RC_ENROLL_CODE="${RC_ENROLL_CODE:-$(openssl rand -hex 32)}"
  TOKEN_SECRET="${TOKEN_SECRET:-$(openssl rand -hex 32)}"
  INTERNAL_MQTT_PASSWORD="${INTERNAL_MQTT_PASSWORD:-$(openssl rand -hex 32)}"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  # Replace placeholders in-place without printing secrets
  sed -i "s#^RC_ENROLL_CODE=.*#RC_ENROLL_CODE=$RC_ENROLL_CODE#" "$ENV_FILE"
  sed -i "s#^INTERNAL_MQTT_PASSWORD=.*#INTERNAL_MQTT_PASSWORD=$INTERNAL_MQTT_PASSWORD#" "$ENV_FILE"
  sed -i "s#^TOKEN_SECRET=.*#TOKEN_SECRET=$TOKEN_SECRET#" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # One-time output of the enrollment code — owner types this into APK onboarding
  echo ""
  echo "=== FLEET ENROLLMENT CODE (share with device owner, one-time) ==="
  echo "$RC_ENROLL_CODE"
  echo "================================================================"
  echo ""
else
  log ".env already exists — leaving untouched"
fi

# 4. Back up existing nginx sites + letsencrypt before any change
log "Backing up nginx sites and letsencrypt"
TS="$(date +%Y%m%d%H%M%S)"
mkdir -p "/root/android-rc-backup-$TS"
cp -a /etc/nginx/sites-enabled "/root/android-rc-backup-$TS/" 2>/dev/null || true
cp -a /etc/letsencrypt "/root/android-rc-backup-$TS/" 2>/dev/null || true

# 5. Install nginx vhost
log "Installing nginx vhost"
cp "$SRC/deploy/nginx-android.conf" /etc/nginx/sites-available/android-rc.conf
ln -sf /etc/nginx/sites-available/android-rc.conf /etc/nginx/sites-enabled/android-rc.conf
nginx -t && systemctl reload nginx

# 6. Run certbot if certs missing
if [ ! -d /etc/letsencrypt/live/android.spaceworker.top ]; then
  log "Certs missing — run deploy/certbot.sh first, then re-run install.sh"
  exit 0
fi

# 7. Install node dependencies (box host)
log "npm install"
cd "$DST"
npm install --no-audit --no-fund >/tmp/android-rc-npm-install.log 2>&1 || { echo "[install] FATAL: npm install failed"; tail -20 /tmp/android-rc-npm-install.log; exit 1; }

# 8. Start mosquitto (host network: binds 1883 localhost + 8883 TLS public directly,
#    bypassing the broken docker loopback userland-proxy on this host)
if docker ps -a --format '{{.Names}}' | grep -q '^android-rc-mqtt$'; then
  log "mosquitto container exists — starting"
  docker start android-rc-mqtt 2>/dev/null || true
else
  log "Starting mosquitto (host network)"
  docker run -d --name android-rc-mqtt --network host \
    -v "$DST/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
    -v "$DST/mosquitto/acl:/mosquitto/config/acl:ro" \
    -v /etc/letsencrypt/live/android.spaceworker.top:/etc/letsencrypt/live/android.spaceworker.top:ro \
    eclipse-mosquitto:2.0.18 >/dev/null
fi
sleep 2

# 9. Start api + relay as host processes (bind 127.0.0.1:8090/8081; nginx proxies them)
set -a; . "$ENV_FILE"; set +a
export MQTT_HOST=127.0.0.1
pkill -f 'node api/index.mjs' 2>/dev/null || true
pkill -f 'node relay/index.mjs' 2>/dev/null || true
nohup node "$DST/api/index.mjs" > /tmp/rc-api.log 2>&1 &
nohup node "$DST/relay/index.mjs" > /tmp/rc-relay.log 2>&1 &
sleep 2

log "Install complete. .env at $ENV_FILE (600). Fleet enrollment code printed above (one-time)."
log "Verify: curl -s https://android.spaceworker.top/api/health  (expect {\"ok\":true,...})"