#!/usr/bin/env bash
# Nightly backup for the instaweb box -> Cloudflare R2.
#
# Covers everything needed to rebuild this server on new metal:
#   * all four Postgres databases: spaceworker, vantra, tacticalrmm (devices /
#     agents), meshcentral (mesh nodes / groups / login-cookie key)
#   * Postgres globals (roles + grants; a database dump alone cannot restore them)
#   * critical config/secrets: app .env files, TRMM settings + NATS confs,
#     MeshCentral config + certs, nginx, our systemd units, letsencrypt
#   * small on-disk user data: hosted-sites, cyberlab contexts/sessions
#
# Runs via db-backup.timer. Every credential and path that varies comes from
# /etc/instaweb-backup.env (EnvironmentFile=) — nothing secret is hardcoded here.
#
# Deliberately NOT backed up: device screenshots (large + sensitive, pruned by
# the app), installers/build artefacts (reproducible), application code/venv.
#
# Exit code: 0 only when EVERY part uploaded. Any failure -> Telegram + exit 1,
# and the _status/last-success.json manifest is NOT refreshed.

set -uo pipefail

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
EPOCH=$(date -u +%s)
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/root/db-backups}"
R2_ROOT="r2backup:${R2_BUCKET:?R2_BUCKET missing from EnvironmentFile}"
mkdir -p "$LOCAL_DIR"

FAILURES=()
DONE_PARTS=()

say() { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { FAILURES+=("$*"); echo "FAIL: $*" >&2; }

r2_put() { # localfile  remote-relative-path
  rclone copyto --s3-no-check-bucket "$1" "${R2_ROOT}/$2"
}

backup_url_db() { # name  connection-url
  local name="$1" url="$2"
  local file="$LOCAL_DIR/${name}-${TIMESTAMP}.sql.gz"
  if pg_dump --no-owner --no-acl "$url" 2>/dev/null | gzip > "$file" && [ -s "$file" ]; then
    if r2_put "$file" "${name}/${name}-${TIMESTAMP}.sql.gz"; then
      DONE_PARTS+=("$name")
      say "OK: $name DB -> ${name}/${name}-${TIMESTAMP}.sql.gz ($(du -h "$file" | cut -f1))"
    else
      fail "$name: R2 upload failed"
    fi
  else
    fail "$name: pg_dump failed or produced an empty file"
  fi
}

backup_local_db() { # name  (local peer auth as the postgres superuser)
  local name="$1"
  local file="$LOCAL_DIR/${name}-${TIMESTAMP}.sql.gz"
  if sudo -u postgres pg_dump --no-owner --no-acl -d "$name" 2>/dev/null | gzip > "$file" && [ -s "$file" ]; then
    if r2_put "$file" "${name}/${name}-${TIMESTAMP}.sql.gz"; then
      DONE_PARTS+=("$name")
      say "OK: $name DB -> ${name}/${name}-${TIMESTAMP}.sql.gz ($(du -h "$file" | cut -f1))"
    else
      fail "$name: R2 upload failed"
    fi
  else
    fail "$name: pg_dump failed or produced an empty file"
  fi
}

upload_archive() { # label  localfile  remote-relative-path
  local label="$1" file="$2" dest="$3"
  if [ -s "$file" ] && r2_put "$file" "$dest"; then
    DONE_PARTS+=("$label")
    say "OK: $label -> $dest ($(du -h "$file" | cut -f1))"
  else
    fail "$label: archive missing/empty or R2 upload failed"
  fi
}

# ---------------------------------------------------------------- databases
backup_url_db vantra "$DATABASE_URL_VANTRA"
backup_url_db spaceworker "$DATABASE_URL_SPACEWORKER"
backup_local_db tacticalrmm
backup_local_db meshcentral

# ---------------------------------------------------------------- globals
GLOBALS="$LOCAL_DIR/postgres-globals-${TIMESTAMP}.sql.gz"
if sudo -u postgres pg_dumpall --globals-only 2>/dev/null | gzip > "$GLOBALS" && [ -s "$GLOBALS" ]; then
  upload_archive postgres-globals "$GLOBALS" "globals/postgres-globals-${TIMESTAMP}.sql.gz"
else
  fail "postgres-globals: pg_dumpall --globals-only failed"
fi

# ---------------------------------------------------------------- config / secrets
CONFIG_TAR="$LOCAL_DIR/instaweb-config-${TIMESTAMP}.tar.gz"
CONFIG_PATHS=(
  opt/spaceworker/.env
  opt/vantra/.env
  etc/instaweb-backup.env
  rmm/api/tacticalrmm/local_settings.py
  rmm/api/tacticalrmm/app.ini
  rmm/api/tacticalrmm/nats-rmm.conf
  rmm/api/tacticalrmm/nats-api.conf
  meshcentral/meshcentral-data/config.json
  meshcentral/meshcentral-data/serverstate.txt
  meshcentral/meshcentral-data/agentserver-cert-public.crt
  meshcentral/meshcentral-data/codesign-cert-private.key
  meshcentral/meshcentral-data/codesign-cert-public.crt
  meshcentral/meshcentral-data/mpsserver-cert-private.key
  meshcentral/meshcentral-data/mpsserver-cert-public.crt
  meshcentral/meshcentral-data/root-cert-private.key
  meshcentral/meshcentral-data/root-cert-public.crt
  meshcentral/meshcentral-data/webserver-cert-private.key
  meshcentral/meshcentral-data/webserver-cert-public.crt
  etc/nginx/sites-available
  etc/letsencrypt
  etc/systemd/system/db-backup.service
  etc/systemd/system/db-backup.timer
  etc/systemd/system/db-backup-health.service
  etc/systemd/system/db-backup-health.timer
  opt/spaceworker/deploy/backup-databases.sh
  opt/spaceworker/deploy/backup-health.sh
)
CONFIG_EXISTING=()
for p in "${CONFIG_PATHS[@]}"; do [ -e "/$p" ] && CONFIG_EXISTING+=("$p"); done
if tar czf "$CONFIG_TAR" -C / "${CONFIG_EXISTING[@]}" 2>/dev/null; then
  upload_archive instaweb-config "$CONFIG_TAR" "config/instaweb-config-${TIMESTAMP}.tar.gz"
else
  fail "instaweb-config: tar failed"
fi

# ---------------------------------------------------------------- small user data
DATA_TAR="$LOCAL_DIR/spaceworker-data-${TIMESTAMP}.tar.gz"
DATA_PATHS=(
  opt/spaceworker/hosted-sites
  opt/spaceworker/cyberlab-contexts
  opt/spaceworker/cyberlab-sessions
)
DATA_EXISTING=()
for p in "${DATA_PATHS[@]}"; do [ -e "/$p" ] && DATA_EXISTING+=("$p"); done
if [ ${#DATA_EXISTING[@]} -gt 0 ] && tar czf "$DATA_TAR" -C / "${DATA_EXISTING[@]}" 2>/dev/null; then
  upload_archive spaceworker-data "$DATA_TAR" "spaceworker-data/spaceworker-data-${TIMESTAMP}.tar.gz"
else
  fail "spaceworker-data: tar failed or no data directories exist"
fi

# ---------------------------------------------------------------- retention
# Local copies are just a fast fallback; R2 is authoritative. 3 days local.
find "$LOCAL_DIR" \( -name '*.sql.gz' -o -name '*.tar.gz' \) -mtime +3 -delete
# 30 days of nightly history per prefix. A failed prune is not data loss.
for prefix in vantra spaceworker tacticalrmm meshcentral globals config spaceworker-data; do
  rclone delete --s3-no-check-bucket --min-age 30d "${R2_ROOT}/${prefix}/" >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------- manifest + exit
if [ ${#FAILURES[@]} -eq 0 ]; then
  MANIFEST="$LOCAL_DIR/last-success.json"
  printf '{"epoch":%s,"utc":"%s","databases":["spaceworker","vantra","tacticalrmm","meshcentral"],"parts":"%s"}\n' \
    "$EPOCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${DONE_PARTS[*]}" > "$MANIFEST"
  if r2_put "$MANIFEST" "_status/last-success.json"; then
    say "OK: success manifest uploaded"
  else
    fail "_status/last-success.json upload failed"
  fi
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  JOINED=$(IFS='; '; echo "${FAILURES[*]}")
  MSG="Nightly backup FAILED: ${JOINED}"
  say "$MSG"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ADMIN_TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${ADMIN_TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${MSG}" >/dev/null || true
  fi
  exit 1
fi

say "Nightly backup completed successfully (${#DONE_PARTS[@]} parts)."
