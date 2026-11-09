#!/usr/bin/env bash
# deploy/certbot.sh — obtain TLS cert for android.spaceworker.top via webroot
set -euo pipefail

DOMAIN="android.spaceworker.top"
WEBROOT="/var/www/certbot"

mkdir -p "$WEBROOT"

certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
  --deploy-hook "systemctl restart mosquitto 2>/dev/null || docker restart android-rc-mosquitto 2>/dev/null || true" \
  --non-interactive --agree-tos

echo "Certs at /etc/letsencrypt/live/$DOMAIN/"