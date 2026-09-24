#!/usr/bin/env bash
#
# Safe VPS deploy for SpaceWorker / Vantra (rsync + build + restart + verify).
#
# WHY THIS EXISTS (owner incident 2026-09-24 — "everything is broken, site down"):
# The VPS has NO git checkout. `/opt/spaceworker` is an rsync target whose
# *runtime state never exists in the local repo*: `.env`, `.next/`, `static/`,
# `engine-dist/`, `worker/.env`, `worker/venv/`, `node_modules/`. A hand-run
#     rsync ... --delete --files-from=/tmp/deploy-files.txt ./ root@HOST:/opt/spaceworker/
# is fine ONLY as long as the list has no root-level entry. The moment it lists
# a root file (`package.json`, `next.config.ts`, …), `--delete` treats that
# directory as authoritative and removes *every other* root path it can see —
# which is how a single deploy simultaneously:
#   * wiped `.env`        → extractor stuck "queued", browser unconfigured,
#                           US/Canada routes vanished (silent, feature-by-feature)
#   * wiped `.next/`      → `next start` crash-looped 37× ("Could not find a
#                           production build") and the public site 502'd
#   * wiped `static/`     → nginx lost its maintenance.html fallback, so users
#                           saw raw nginx 502 pages instead
#   * overwrote systemd units with `%INTERNAL_BEARER_TOKEN%` placeholders → 401s
#
# So this wrapper makes those paths structurally un-deletable:
#   1. `--delete` is opt-in via `--prune`.
#   2. Even then, server-only runtime paths are hard-excluded.
#   3. `.env` is rejected from the file list outright, and snapshotted first.
#   4. Deployed files are chowned to the service user (rsync lands them as your
#      local uid, e.g. 502 — which is how `/opt/spaceworker` ended up owned by
#      a macOS uid).
#   5. A post-deploy assertion proves the server-only runtime survived.
#
# USAGE
#   scripts/deploy-vps.sh <files-from-list> [--prune] [--no-build] [--no-restart]
#   scripts/deploy-vps.sh --verify-only
#
# ENV OVERRIDES
#   VPS_HOST (default root@164.68.105.96)  SSH_KEY (default ~/.ssh/tacticalrmm_vps)
#   APP_DIR  (default /opt/spaceworker)     SERVICE (default spaceworker.service)
#   PORT     (default 3500)                 LOCAL_ROOT (default: repo root)
#
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@164.68.105.96}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/tacticalrmm_vps}"
APP_DIR="${APP_DIR:-/opt/spaceworker}"
SERVICE="${SERVICE:-spaceworker.service}"
PORT="${PORT:-3500}"
LOCAL_ROOT="${LOCAL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"


FILES_FROM=""
PRUNE=0
DO_BUILD=1
DO_RESTART=1
VERIFY_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --prune)       PRUNE=1 ;;
    --no-build)    DO_BUILD=0 ;;
    --no-restart)  DO_RESTART=0 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help)     sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*)            echo "unknown flag: $arg" >&2; exit 2 ;;
    *)             FILES_FROM="$arg" ;;
  esac
done

run_remote() { ssh -i "$SSH_KEY" -o BatchMode=yes "$VPS_HOST" "$@"; }

# --- Server-only runtime that must EXIST after any deploy ---------------------
# Kept as one list so the exclude set and the assertion can never drift apart.
REQUIRED_PATHS=(".env" ".next" "node_modules" "static/maintenance.html")

# Paths that must never be deleted by a sync (dirs are matched recursively).
PROTECTED=(
  ".env" ".env.local"
  ".next" "node_modules" "static" "engine-dist"
  "worker/.env" "worker/venv" "worker/__pycache__"
  "mint-session.mjs" "*.log"
)

verify_runtime() {
  echo "-- asserting server-only runtime survived"
  local missing=0 p
  for p in "${REQUIRED_PATHS[@]}"; do
    if run_remote "test -e '$APP_DIR/$p'"; then
      echo "   ok      $p"
    else
      echo "   MISSING $p   <- deploy destroyed runtime state" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || { echo "FAIL: server-only runtime incomplete - recover before restarting." >&2; return 1; }
  return 0
}

if [ "$VERIFY_ONLY" -eq 1 ]; then
  verify_runtime
  run_remote "systemctl is-active '$SERVICE' && curl -s -o /dev/null -w 'http:%{http_code}\n' -m 15 http://localhost:$PORT/"
  exit $?
fi

[ -n "$FILES_FROM" ] || { echo "usage: $0 <files-from-list> [--prune] [--no-build] [--no-restart]" >&2; exit 2; }
[ -f "$FILES_FROM" ] || { echo "file list not found: $FILES_FROM" >&2; exit 2; }

# --- 1. Refuse a list that could clobber secrets ------------------------------
if grep -qE '(^|/)\.env($|\.)' "$FILES_FROM"; then
  echo "REFUSED: the file list contains a .env path. Server .env files are" >&2
  echo "hand-maintained on the VPS and do not exist in the repo. Edit them with" >&2
  echo "a targeted ssh sed/append instead." >&2
  exit 1
fi

# --- 2. Snapshot .env + confirm protected paths exist BEFORE touching anything -
echo "-- preflight"
STAMP="$(date +%Y%m%d%H%M%S)"
run_remote "cp -a '$APP_DIR/.env' '/root/$(basename "$APP_DIR").env.bak-$STAMP' && echo '   snapshot: /root/$(basename "$APP_DIR").env.bak-$STAMP'"
verify_runtime

# --- 3. Build the rsync args -------------------------------------------------
RSYNC_ARGS=(-avz "--files-from=$FILES_FROM")
if [ "$PRUNE" -eq 1 ]; then
  echo "   --prune set: deleting files absent from the list (protected paths excluded)"
  for p in "${PROTECTED[@]}"; do RSYNC_ARGS+=(--exclude="$p"); done
  RSYNC_ARGS+=(--delete)   # NOT --delete-excluded: excluded paths must stay
else
  echo "   (no --prune: purely additive sync, nothing is deleted)"
fi

# --- 4. Sync ----------------------------------------------------------------
echo "-- rsync"
( cd "$LOCAL_ROOT" && rsync "${RSYNC_ARGS[@]}" -e "ssh -i $SSH_KEY -o BatchMode=yes" ./ "$VPS_HOST:$APP_DIR/" )

# --- 5. Ownership (rsync lands files as the LOCAL uid, not the service user) --
SERVICE_USER="$(run_remote "systemctl show '$SERVICE' -p User --value" | tr -d '\r')"
SERVICE_USER="${SERVICE_USER:-root}"
echo "-- chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR"
run_remote "chown -R '$SERVICE_USER:$SERVICE_USER' '$APP_DIR'"

# --- 6. Build + restart + verify --------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  echo "-- build (as $SERVICE_USER)"
  run_remote "cd '$APP_DIR' && sudo -u '$SERVICE_USER' npm run build 2>&1 | tail -n 15"
fi

if [ "$DO_RESTART" -eq 1 ]; then
  echo "-- restart + verify"
  run_remote "systemctl restart '$SERVICE' && sleep 6 && systemctl is-active '$SERVICE'"
  CODE="$(run_remote "curl -s -o /dev/null -w '%{http_code}' -m 20 http://localhost:$PORT/")"
  echo "   localhost:$PORT/ -> $CODE"
  [ "$CODE" = "200" ] || { echo "FAIL: app is not serving (journalctl -u $SERVICE)" >&2; exit 1; }
  verify_runtime
fi

echo "-- done"
