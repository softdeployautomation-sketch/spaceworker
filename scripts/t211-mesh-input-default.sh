#!/usr/bin/env bash
# ============================================================================
# TASK_211 apply — fresh browsers must land with MeshCentral "Input" UNCHECKED.
#
# Task doc: TASK_211_MESH_CONNECT_INPUT_AUTOCHECK.md §3 Option A.
# Rewrites MeshCentral's own default `getstore("DeskControl",1)` (=checked) to
# `,0` ON THE WIRE (nginx sub_filter) on BOTH mesh vhosts, so after Connect the
# session comes up with input OFF and the user checks the box themselves.
# MeshCentral's putstore persistence (the user's own toggle) is NOT touched.
#
# Properties: idempotent (marker-guarded), rollback-safe (nginx -t before AND
# after; backups restored + exit nonzero on failure), anchored (dies loudly if
# the SSL server block / 127.0.0.1:4430 proxy_pass / server_name anchor is
# missing — never guesses), reload-only (never restart), read-only outside
# /etc/nginx/sites-enabled + the baseline file (NEVER writes /opt/spaceworker,
# never touches spaceworker.service / meshcentral.service / /opt/vantra / git).
#
# Run as root ON THE BOX (senior verification agent):
#     bash scripts/t211-mesh-input-default.sh ; echo "exit=$?"
# Local fixture mode (task agent, no VPS): T211_NGINX_DIR / T211_BUILD_ID /
# T211_BASELINE override paths; nginx/systemctl resolve via $PATH.
#
# Output: OK|<id>|<detail> / WARN|... / FAIL|... / RESULT|applied=N skipped=M
# Exit 0 = confs valid + reloaded (or idempotently skipped); 1 = FAIL (edits of
# this run rolled back where applicable — see the FAIL line).
# ============================================================================
set -u

NGINX_DIR="${T211_NGINX_DIR:-/etc/nginx/sites-enabled}"
BUILD_ID="${T211_BUILD_ID:-/opt/spaceworker/.next/BUILD_ID}"
BASELINE="${T211_BASELINE:-/var/tmp/t211-baseline-buildid}"
UPSTREAM_RE='127\.0\.0\.1:4430'
MARKER='>>> TASK_211'
CONF_FILES=("$NGINX_DIR/mesh.spaceworker.top.conf" "$NGINX_DIR/meshcentral.conf")

EDITED=()   # confs modified in THIS run = rollback scope

ok()   { printf 'OK|%s|%s\n' "$1" "$2"; }
warn() { printf 'WARN|%s|%s\n' "$1" "$2"; }
rollback() {
  local c
  [ ${#EDITED[@]} -eq 0 ] && return 0
  for c in "${EDITED[@]}"; do
    if [ -f "$c.bak-t211" ]; then
      cp -p "$c.bak-t211" "$c" && printf 'OK|rollback|%s restored from %s.bak-t211\n' "$c" "$c"
    else
      printf 'FAIL|rollback|%s has NO backup — restore manually\n' "$c"
    fi
    rm -f "$c.t211new"
  done
  EDITED=()
}
die() {
  printf 'FAIL|%s|%s\n' "$1" "$2"
  rollback
  exit 1
}

# ---- 0. environment ---------------------------------------------------------
if [ -z "${T211_NGINX_DIR:-}" ]; then
  [ "$(id -u)" -eq 0 ] || die "env.root" "must run as root on the box (no T211_NGINX_DIR override set)"
fi
command -v nginx     >/dev/null 2>&1 || die "env.nginx" "nginx not found in PATH"
command -v systemctl >/dev/null 2>&1 || die "env.systemctl" "systemctl not found in PATH"

# ---- 1. pre-flight: nginx -t must pass BEFORE any change --------------------
if nginx -t >/dev/null 2>&1; then
  ok "preflight.nginx_t" "clean BEFORE any change"
else
  nginx -t 2>&1 || true
  die "preflight.nginx_t" "nginx -t FAILED before any change — refusing to touch anything (fix the box first, then re-run)"
fi

# ---- 2. the marked rewrite block (task doc §3 Option A, verbatim) ------------
BLOCK_FILE="$(mktemp)" || die "block.mktemp" "mktemp failed for the sub_filter block"
trap 'rm -f "$BLOCK_FILE"' EXIT
cat > "$BLOCK_FILE" <<'NGXEOF'
    # >>> TASK_211 — fresh browsers must land with MeshCentral "Input" UNCHECKED.
    # MeshCentral's own default is getstore("DeskControl",1) (=checked); the owner
    # rule: connect connects, the user decides on input. The user's toggle still
    # persists via MeshCentral's putstore — only the default changes.
    # Delete this marked block + `nginx -t && systemctl reload nginx` to revert.
    sub_filter 'getstore("DeskControl",1)' 'getstore("DeskControl",0)';
    sub_filter_once off;                       # both occurrences, not just the first
    proxy_set_header Accept-Encoding "";       # sub_filter cannot match compressed bodies
    gzip on;                                   # re-compress after the rewrite (866 KB page)
    gzip_comp_level 5;
    # <<< TASK_211
NGXEOF

# ---- 3. validate BOTH confs BEFORE editing anything (STOP-and-report) --------
PENDING_CONF=(); PENDING_ANCHOR=(); PENDING_LOC=(); PENDING_NEEDLOC=()
for conf in "${CONF_FILES[@]}"; do
  name="$(basename "$conf")"
  [ -f "$conf" ] || die "conf.missing" "$conf not found — task-doc §3 assumption broken. STOP and report (nothing was changed)."
  if grep -q "$MARKER" "$conf"; then
    ok "conf.$name" "marker already present — SKIP (idempotent)"
    continue
  fi
  if grep -q '^[[:space:]]*sub_filter[[:space:]]' "$conf"; then
    die "conf.foreign_sub_filter" "$conf already carries a sub_filter directive of unknown origin — assumption broken. STOP and report."
  fi
  proxy_line="$(awk "/proxy_pass.*$UPSTREAM_RE/ {print NR; exit}" "$conf")"
  [ -n "$proxy_line" ] || die "conf.upstream" "$conf has no proxy_pass to 127.0.0.1:4430 — assumption broken. STOP and report."
  anchor="$(awk -v p="$proxy_line" '/server_name[[:space:]]/ { sn = NR } NR == p { if (sn) print sn; exit }' "$conf")"
  [ -n "$anchor" ] || die "conf.anchor" "$conf: no server_name line above the 127.0.0.1:4430 proxy_pass (line $proxy_line) — will not guess an insertion point. STOP and report."
  loc="$(awk -v p="$proxy_line" '/^[[:space:]]*location[[:space:]]/ { ln = NR } NR == p { if (ln) print ln; exit }' "$conf")"
  needloc=0
  if [ -n "$loc" ]; then
    # nginx rule: a location that defines its OWN proxy_set_header drops ALL
    # server-level ones → the server-level `Accept-Encoding ""` would be dead
    # and sub_filter would silently match nothing on a compressed upstream body.
    # Fix: also set it as the FIRST directive inside that location.
    needloc="$(awk -v s="$loc" 'NR <= s { next } /^[[:space:]]*(location|server|upstream)[[:space:]]/ { exit } /proxy_set_header/ { f = 1 } END { print f + 0 }' "$conf")"
  else
    warn "conf.$name.location" "no location line above the proxy_pass — inheritance check skipped; the wire verify is authoritative"
  fi
  PENDING_CONF+=("$conf"); PENDING_ANCHOR+=("$anchor")
  PENDING_LOC+=("$loc");   PENDING_NEEDLOC+=("$needloc")
  ok "conf.$name" "validated (proxy_pass line $proxy_line, server_name anchor line $anchor, location proxy_set_header=$needloc)"
done

# ---- 4. edit (backup first, anchored insert, in-place write) -----------------
i=0
while [ "$i" -lt "${#PENDING_CONF[@]}" ]; do
  conf="${PENDING_CONF[$i]}"; anchor="${PENDING_ANCHOR[$i]}"
  loc="${PENDING_LOC[$i]}";   needloc="${PENDING_NEEDLOC[$i]}"
  if [ ! -e "$conf.bak-t211" ]; then
    cp -p "$conf" "$conf.bak-t211" || die "backup.fail" "cannot back up $conf — aborting before any edit"
    ok "backup.$(basename "$conf")" "$conf.bak-t211 created"
  else
    ok "backup.$(basename "$conf")" "pre-existing .bak-t211 kept (idempotent)"
  fi
  if ! awk -v anchor="$anchor" -v loc="$loc" -v needloc="$needloc" -v blk="$BLOCK_FILE" '
      { print }
      NR == anchor { while ((getline l < blk) > 0) print l; close(blk) }
      NR == loc && needloc == 1 { print "    proxy_set_header Accept-Encoding \"\";   # TASK_211 location-level (nginx proxy_set_header inheritance rule)" }
    ' "$conf" > "$conf.t211new"; then
    rm -f "$conf.t211new"
    die "edit.fail" "awk insertion failed for $conf (edits of this run rolled back)"
  fi
  if ! cat "$conf.t211new" > "$conf"; then
    rm -f "$conf.t211new"
    die "edit.write" "write failed for $conf (restored from backup)"
  fi
  rm -f "$conf.t211new"
  EDITED+=("$conf")
  ok "edit.$(basename "$conf")" "marked block after server_name line $anchor; location Accept-Encoding patch=$needloc"
  i=$((i + 1))
done

# ---- 5. post-edit nginx -t → rollback + exit nonzero on failure --------------
if nginx -t >/dev/null 2>&1; then
  ok "postcheck.nginx_t" "clean AFTER edit"
else
  nginx -t 2>&1 || true
  die "postcheck.nginx_t" "nginx -t FAILED after edit — all edits of this run rolled back, reload never ran"
fi

# ---- 6. record the app-untouched baseline (read-only, task doc §5.4) ----------
if [ -f "$BUILD_ID" ]; then
  mtime="$(stat -c '%y' "$BUILD_ID" 2>/dev/null || stat -f '%Sm' "$BUILD_ID" 2>/dev/null)"
  if printf '%s\n' "$mtime" > "$BASELINE"; then
    ok "baseline.build_id" "$BUILD_ID mtime=$mtime recorded in $BASELINE (read-only access to /opt/spaceworker)"
  else
    warn "baseline.build_id" "could not write $BASELINE — the §5.4 app-untouched check will FAIL in verify"
  fi
else
  warn "baseline.build_id" "$BUILD_ID not found — the §5.4 app-untouched check will FAIL in verify"
fi

# ---- 7. reload (NEVER restart; only after a clean post-edit nginx -t) ---------
n_edited=${#EDITED[@]}
if [ "$n_edited" -eq 0 ]; then
  ok "reload" "nothing edited (idempotent re-run) — reload skipped"
elif systemctl reload nginx; then
  ok "reload" "systemctl reload nginx succeeded (reload only, no restart, no other vhost disturbed)"
else
  printf 'FAIL|reload|systemctl reload nginx FAILED — on-disk config is valid (nginx -t clean) but NOT live. Investigate: systemctl status nginx. To revert: cp -p <conf>.bak-t211 <conf> && systemctl reload nginx\n'
  exit 1
fi

printf 'RESULT|applied=%s|next: bash scripts/t211-mesh-input-verify.sh post\n' "$n_edited"
exit 0
