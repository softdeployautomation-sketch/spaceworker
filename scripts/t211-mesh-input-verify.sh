#!/usr/bin/env bash
# ============================================================================
# TASK_211 verify — the §5 battery of TASK_211_MESH_CONNECT_INPUT_AUTOCHECK.md.
# Machine-readable: one `PASS|<id>|<detail>` / `FAIL|<id>|<detail>` /
# `MANUAL|<id>|<detail>` line per assertion; final line `RESULT|PASS|...` or
# `RESULT|FAIL|...` (exit 0 / exit 1).
#
# Usage:  bash scripts/t211-mesh-input-verify.sh [pre|post]      (default post)
#   pre  = BEFORE applying: must show the BUG (2 x default=1 on the live page)
#   post = AFTER apply: 2 x default=0 / 0 x default=1 on BOTH vhosts, plus the
#          nginx -t / marker / backup / service / app-untouched assertions.
#
# Runs on the box (root) — or locally with the T211_* overrides and a
# PATH-stubbed nginx/systemctl/curl for fixture tests.
#
# curl uses --compressed ON PURPOSE: it makes the client ASK for gzip, so the
# whole chain `Accept-Encoding "" -> upstream plain -> sub_filter rewrite ->
# nginx gzip` is exercised exactly like a real browser would. A bare curl (no
# Accept-Encoding header) would NOT prove the compressed-body path.
#
# Browser-side assertions (task doc §5.5/5.6) cannot be machine-checked here —
# they are printed as MANUAL| lines and must be executed by a human on a fresh
# profile / private window (phone + desktop) after this script passes.
# ============================================================================
set -u

MODE="${1:-post}"
case "$MODE" in
  pre|post) ;;
  *) printf 'FAIL|usage|mode must be "pre" or "post", got "%s"\n' "$MODE"; exit 2 ;;
esac

NGINX_DIR="${T211_NGINX_DIR:-/etc/nginx/sites-enabled}"
BUILD_ID="${T211_BUILD_ID:-/opt/spaceworker/.next/BUILD_ID}"
BASELINE="${T211_BASELINE:-/var/tmp/t211-baseline-buildid}"
HOST1="${T211_HOST_CUSTOMER:-mesh.spaceworker.top}"
HOST2="${T211_HOST_ADMIN:-mesh.instaweb.top}"
IP="${T211_BOX_IP:-164.68.105.96}"
PORT="${T211_PORT:-443}"
CONF_FILES=("$NGINX_DIR/mesh.spaceworker.top.conf" "$NGINX_DIR/meshcentral.conf")

N_PASS=0; N_FAIL=0
pass()   { N_PASS=$((N_PASS + 1)); printf 'PASS|%s|%s\n' "$1" "$2"; }
fail()   { N_FAIL=$((N_FAIL + 1)); printf 'FAIL|%s|%s\n' "$1" "$2"; }
manual() { printf 'MANUAL|%s|%s\n' "$1" "$2"; }

# wire_check <host> <want-default1-count> <want-default0-count>
wire_check() {
  local host="$1" want1="$2" want0="$3"
  local f code c0 c1 hint
  f="$(mktemp)"
  code="$(curl -sk --compressed --max-time 25 --resolve "$host:$PORT:$IP" -o "$f" -w '%{http_code}' "https://$host/" 2>/dev/null)"
  if [ "$code" = "200" ]; then
    pass "http.$host" "HTTP 200 from https://$host/ (resolved to $IP)"
  else
    fail "http.$host" "HTTP ${code:-no-response} from https://$host/ (resolved to $IP)"
  fi
  c0="$(grep -oF 'getstore("DeskControl",0)' "$f" 2>/dev/null | wc -l | tr -d ' \t')"
  c1="$(grep -oF 'getstore("DeskControl",1)' "$f" 2>/dev/null | wc -l | tr -d ' \t')"
  [ -n "$c0" ] || c0=0
  [ -n "$c1" ] || c1=0
  if [ "$MODE" = "post" ]; then
    hint="TASK_211 block missing/not live (grep '>>> TASK_211' + nginx -t + reload), or the upstream body is still compressed (server-level proxy_set_header Accept-Encoding \"\" not inherited by the serving location)"
  else
    hint="expected the UNPATCHED upstream default (pre-change ground truth of task doc §5.1)"
  fi
  if [ "$c1" = "$want1" ]; then
    pass "wire.default1.$host" "getstore(\"DeskControl\",1) x$c1 on the live page (want $want1)"
  else
    fail "wire.default1.$host" "getstore(\"DeskControl\",1) x$c1 on the live page (want $want1) — $hint"
  fi
  if [ "$c0" = "$want0" ]; then
    pass "wire.default0.$host" "getstore(\"DeskControl\",0) x$c0 on the live page (want $want0)"
  else
    fail "wire.default0.$host" "getstore(\"DeskControl\",0) x$c0 on the live page (want $want0) — $hint"
  fi
  rm -f "$f"
}

command -v curl >/dev/null 2>&1 || { printf 'FAIL|env.curl|curl not found in PATH\n'; exit 1; }
command -v nginx >/dev/null 2>&1 || { printf 'FAIL|env.nginx|nginx not found in PATH\n'; exit 1; }
command -v systemctl >/dev/null 2>&1 || { printf 'FAIL|env.systemctl|systemctl not found in PATH\n'; exit 1; }

if [ "$MODE" = "pre" ]; then
  # Task doc §5 pre-change: the bug MUST be visible (2 x default=1).
  wire_check "$HOST1" 2 0
  wire_check "$HOST2" 2 0
else
  # ---- task doc §5.2: the rewrite is live on BOTH vhosts ---------------------
  wire_check "$HOST1" 0 2
  wire_check "$HOST2" 0 2

  # ---- task doc §5.3: confs marked, backed up, nginx -t clean ----------------
  if nginx -t >/dev/null 2>&1; then
    pass "nginx.t" "nginx -t clean"
  else
    nginx -t 2>&1 | tail -n 5 || true
    fail "nginx.t" "nginx -t FAILED"
  fi
  for conf in "${CONF_FILES[@]}"; do
    name="$(basename "$conf")"
    n="$(grep -c '>>> TASK_211' "$conf" 2>/dev/null)" || true
    [ -n "$n" ] || n=0
    if [ "$n" = "1" ]; then
      pass "marker.$name" "grep -c '>>> TASK_211' → 1"
    else
      fail "marker.$name" "grep -c '>>> TASK_211' → $n (want exactly 1)"
    fi
    if [ -f "$conf.bak-t211" ]; then
      pass "backup.$name" "$conf.bak-t211 exists (rollback point)"
    else
      fail "backup.$name" "$conf.bak-t211 missing — no rollback point"
    fi
  done

  # ---- task doc §5.4: services up, app never touched ------------------------
  for svc in nginx meshcentral spaceworker; do
    st="$(systemctl is-active "$svc" 2>/dev/null)"
    if [ "$st" = "active" ]; then
      pass "service.$svc" "systemctl is-active → active"
    else
      fail "service.$svc" "systemctl is-active → ${st:-unknown}"
    fi
  done
  if [ ! -f "$BASELINE" ]; then
    fail "app.untouched" "baseline $BASELINE missing — run t211-mesh-input-default.sh first (it records the BUILD_ID mtime before reload)"
  elif [ ! -f "$BUILD_ID" ]; then
    fail "app.untouched" "$BUILD_ID NOT FOUND — /opt/spaceworker/.next is gone?! STOP and report"
  else
    cur="$(stat -c '%y' "$BUILD_ID" 2>/dev/null || stat -f '%Sm' "$BUILD_ID" 2>/dev/null)"
    base="$(cat "$BASELINE")"
    if [ "$cur" = "$base" ]; then
      pass "app.untouched" "BUILD_ID mtime unchanged ($cur) — /opt/spaceworker never touched"
    else
      fail "app.untouched" "BUILD_ID mtime CHANGED: '$base' → '$cur' — the app/deploy chain was touched during this task (must never happen)"
    fi
  fi

  # ---- task doc §5.5/5.6 + negative test: human-in-the-browser --------------
  manual "browser.connect_input_off" "fresh profile/private window: Console → Connect → session comes up, Input UNCHECKED, mouse+keyboard inert"
  manual "browser.input_enable" "check Input → mouse+keyboard work immediately"
  manual "browser.persist_checked" "reload the MeshCentral page → checkbox stays CHECKED (putstore path intact)"
  manual "browser.persist_unchecked" "uncheck → input off again, and it persists too"
  manual "browser.mobile_newtab" "mobile launcher card → 'Open remote console' new tab → same unchecked default in the tab"
  manual "browser.websocket_e2e" "mesh.spaceworker.top AND mesh.instaweb.top render 200 and websockets connect (console usable end-to-end)"
  manual "browser.neg_stored_state" "an OLD browser that previously CHECKED Input still comes up CHECKED (stored user state must NOT be clobbered)"
fi

if [ "$N_FAIL" -eq 0 ]; then
  printf 'RESULT|PASS|pass=%s fail=%s mode=%s\n' "$N_PASS" "$N_FAIL" "$MODE"
  exit 0
else
  printf 'RESULT|FAIL|pass=%s fail=%s mode=%s\n' "$N_PASS" "$N_FAIL" "$MODE"
  exit 1
fi
