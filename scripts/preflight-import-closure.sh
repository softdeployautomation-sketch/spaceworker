#!/usr/bin/env bash
#
# preflight-import-closure.sh — TASK_210 S4: the missing-sibling detector.
#
# WHY (2026-10-14, the 4-hour outage): components/device-console.tsx shipped and
# imported lib/clone-browsers.ts, which was absent from the deploy — the build
# died and diagnosis ate half a day. A deploy list is only as safe as its
# imports: every @/… and relative import each listed file makes must resolve —
# locally ALWAYS, and with --box also under $APP_DIR on the VPS. Regex-level on
# purpose (no tsc run); tsconfig maps "@/*" -> "./*" (read from tsconfig.json).
#
# usage:
#   scripts/preflight-import-closure.sh <files-list> [--box]
#   --box  also verify every resolved target exists on the VPS
#          (VPS_HOST / SSH_KEY / APP_DIR env overrides, same as deploy-vps.sh)
#
# output:
#   MISSING <importing-file> -> <specifier>   (no candidate on disk locally)
#   MISSING_ON_BOX <rel-path>                 (resolved locally, absent on VPS)
#   ok — <n> imports resolved across <m> file(s)
# exit 1 on any MISSING / MISSING_ON_BOX; 2 on unreachable box (check didn't run).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VPS_HOST="${VPS_HOST:-root@164.68.105.96}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/tacticalrmm_vps}"
APP_DIR="${APP_DIR:-/opt/spaceworker}"

FILES_FROM=""
BOX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --box) BOX=1; shift ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) FILES_FROM="$1"; shift ;;
  esac
done
[ -n "$FILES_FROM" ] || { echo "usage: $0 <files-list> [--box]" >&2; exit 2; }
[ -f "$FILES_FROM" ] || { echo "no such file list: $FILES_FROM" >&2; exit 2; }

# --- "@/*" mapping, read from tsconfig.json (works across line breaks) --------
MAP_RAW="$(tr '\n' ' ' < tsconfig.json \
  | grep -oE '"@/\*"[[:space:]]*:[[:space:]]*\[[[:space:]]*"[^"]+"' \
  | head -1 | sed -E 's/.*"([^"]+)"[[:space:]]*\]$/\1/')" || true
MAP_DIR="$REPO_ROOT"
if [ -n "$MAP_RAW" ]; then
  MAP_BASE="${MAP_RAW%\*}"           # "./*" -> "." ; "./src/*" -> "./src"
  MAP_DIR="$(cd "$REPO_ROOT" && cd "${MAP_BASE:-.}" 2>/dev/null && pwd)" || MAP_DIR="$REPO_ROOT"
fi

TARGETS="$(mktemp)"
trap 'rm -f "$TARGETS"' EXIT
FAIL=0
N_IMPORTS=0
N_FILES=0

# Try the specifier as a real file first, then with code extensions, then as a
# directory (…/index.*) — the three shapes a bundler accepts.
resolve_target() {
  local base="$1" c
  for c in "$base" "$base.ts" "$base.tsx" "$base.js" "$base.jsx" "$base.mjs" \
           "$base.cjs" "$base.json" "$base/index.ts" "$base/index.tsx" \
           "$base/index.js" "$base/index.jsx"; do
    if [ -e "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in */) continue ;; esac
  case "$f" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;; *) continue ;; esac
  if [ ! -f "$f" ]; then
    echo "MISSING_LISTED $f (in list but not in working tree)"
    FAIL=1
    continue
  fi
  N_FILES=$((N_FILES + 1))
  basedir="$(dirname "$f")"
  specs="$(grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" "$f" 2>/dev/null \
    | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" | sort -u)" || true
  [ -z "$specs" ] && continue
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    case "$spec" in
      @/*)      cand_base="$MAP_DIR/${spec#@/}" ;;
      ./*|../*) cand_base="$basedir/$spec" ;;
      *)        continue ;;   # bare package / node: / http(s): — out of scope
    esac
    N_IMPORTS=$((N_IMPORTS + 1))
    if resolved="$(resolve_target "$cand_base")"; then
      printf '%s\n' "$resolved" >> "$TARGETS"
    else
      echo "MISSING $f -> $spec   (tried: $cand_base + exts + /index.*)"
      FAIL=1
    fi
  done <<EOF
$specs
EOF
done < "$FILES_FROM"

# --- --box: same targets, checked under $APP_DIR over ONE ssh connection ------
if [ "$BOX" -eq 1 ]; then
  RELS="$(mktemp)"
  sort -u "$TARGETS" | while IFS= read -r t; do
    case "$t" in
      "$REPO_ROOT"/*) printf '%s\n' "${t#"$REPO_ROOT"/}" ;;
      *)              printf '%s\n' "$t" ;;
    esac
  done > "$RELS"
  if ! BOX_MISSING="$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 \
      -o ServerAliveInterval=10 -o ServerAliveCountMax=3 "$VPS_HOST" \
      "cd '$APP_DIR' && while IFS= read -r p; do [ -e \"\$p\" ] || printf '%s\n' \"\$p\"; done" \
      < "$RELS")"; then
    rm -f "$RELS"
    echo "REFUSED: $VPS_HOST did not answer over ssh — box check did NOT run." >&2
    exit 2
  fi
  rm -f "$RELS"
  if [ -n "$BOX_MISSING" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] && echo "MISSING_ON_BOX $p"
    done <<EOF
$BOX_MISSING
EOF
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "IMPORT CLOSURE BROKEN — add the missing siblings to the deploy list (or fix the import)." >&2
  exit 1
fi
if [ "$BOX" -eq 1 ]; then
  echo "ok — $N_IMPORTS import(s) resolved across $N_FILES file(s), incl. box check ($VPS_HOST:$APP_DIR)."
else
  echo "ok — $N_IMPORTS import(s) resolved across $N_FILES file(s), local only."
fi
