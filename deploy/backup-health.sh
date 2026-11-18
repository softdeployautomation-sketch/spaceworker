#!/usr/bin/env bash
# Independent freshness check for the nightly R2 backup.
#
# Why this exists: db-backup.service showing "Result=success" only proves the
# LAST invocation exited cleanly — not that a usable dump reached R2 recently.
# This runs on its own timer (every 6h) and alerts when the last FULL success
# is older than MAX_AGE_HOURS, or when any database prefix in R2 is empty.
#
# Usage: backup-health.sh [MAX_AGE_HOURS] [--dry-run]
#   --dry-run  print what would happen, send no Telegram message
#
# Reads /etc/instaweb-backup.env via the systemd unit; never prints secrets.

set -uo pipefail

MAX_AGE_HOURS=36
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) MAX_AGE_HOURS="$arg" ;;
  esac
done
case "$MAX_AGE_HOURS" in (*[!0-9]*|'') echo "invalid MAX_AGE_HOURS: $MAX_AGE_HOURS" >&2; exit 2 ;; esac

R2_ROOT="r2backup:${R2_BUCKET:?R2_BUCKET missing from EnvironmentFile}"
now=$(date -u +%s)
problems=()

raw=$(rclone cat --s3-no-check-bucket "${R2_ROOT}/_status/last-success.json" 2>/dev/null || true)
epoch=$(printf '%s' "$raw" | sed -n 's/.*"epoch"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)

age=""
if [ -z "$epoch" ]; then
  problems+=("no readable _status/last-success.json in R2")
else
  age=$(( (now - epoch) / 3600 ))
  [ "$age" -gt "$MAX_AGE_HOURS" ] && \
    problems+=("last full backup success was ${age}h ago (limit ${MAX_AGE_HOURS}h)")
fi

# Fallback signal: even with a fresh manifest, every DB prefix must be populated.
for db in spaceworker vantra tacticalrmm meshcentral; do
  n=$(rclone lsf --s3-no-check-bucket "${R2_ROOT}/${db}/" 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] && problems+=("no objects under ${db}/ in R2")
done

if [ ${#problems[@]} -eq 0 ]; then
  echo "OK: last full backup ${age}h ago; all four DB prefixes populated."
  exit 0
fi

joined=$(IFS='; '; echo "${problems[*]}")
echo "STALE: ${joined}" >&2

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: would send Telegram alert to ADMIN_TELEGRAM_CHAT_ID"
  exit 1
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ADMIN_TELEGRAM_CHAT_ID:-}" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ADMIN_TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=Backup health: ${joined}" >/dev/null || true
fi
exit 1
