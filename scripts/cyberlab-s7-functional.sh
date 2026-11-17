#!/usr/bin/env bash
# Cyberlab S7 deploy functional proof (HANDOFF_CYBERLAB_NEXT_DEPLOY §5):
#  a) GET  /cyberlab with a session                      -> 200 (console)
#  b) GET  /cyberlab/replay/<id> with a session          -> 200 (NEW route — exists
#     ONLY in the new build, so 200 proves the new build serves)
#  c) GET  /api/cyberlab/runs/<id>/artefacts (no body)   -> 405/401/403, NOT 404
#     (route file registered; POST-only so GET is a method refusal)
#  d) POST same path, NO session                         -> 401 (handler auth runs)
#  e) POST same path, session + foreign id + valid body  -> 403 (module gate) or
#     404 (owner-first refusal). All refusal paths — ZERO rows written by design.
# Session minted exactly like lib/auth.ts (HS256, iss/aud 'spaceworker', cookie
# spaceworker_session) using the box SESSION_SECRET; node runs from /opt/spaceworker
# so jose resolves from the service's node_modules.
# Log: /tmp/cy7-functional.txt
set -u
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/cy7-functional.txt
: > "$OUT"
log(){ echo "$@" >> "$OUT"; }
log '=== cyberlab S7 functional proof ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 'bash -s' >> "$OUT" 2>&1 <<'BOX'
set -u
cd /opt/spaceworker || exit 1
U=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//" | tr -d '[:space:]')
# tier-5 passes every module key via hasEntitlement (module-gate.ts header).
PROBE_USER=$(psql "$U" -qAtc 'select id from "User" where tier=5 order by "createdAt" desc limit 1')
[ -z "$PROBE_USER" ] && PROBE_USER=$(psql "$U" -qAtc 'select id from "User" order by "createdAt" desc limit 1')
[ -z "$PROBE_USER" ] && { echo 'NO_USER'; exit 1; }
echo "probe user=$PROBE_USER"
SECRET=$(grep -m1 '^SESSION_SECRET=' .env | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//")
[ -z "$SECRET" ] && { echo 'NO_SESSION_SECRET'; exit 1; }
TOKEN=$(sudo -u trmm node -e '
const { SignJWT } = require("jose");
const key = new TextEncoder().encode(process.argv[2]);
(async () => {
  const t = await new SignJWT({ email: "cy7-probe@localhost", emailVerified: true, scope: "full" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(process.argv[1])
    .setIssuedAt().setExpirationTime("1h")
    .setIssuer("spaceworker").setAudience("spaceworker")
    .sign(key);
  process.stdout.write(t);
})().catch((e) => { console.error(String(e)); process.exit(1); });
' "$PROBE_USER" "$SECRET")
[ -z "$TOKEN" ] && { echo 'MINT_FAILED'; exit 1; }
echo "mint ok (len=${#TOKEN})"
CK="spaceworker_session=$TOKEN"
RID="cy7deadbeef0001"
BASE=https://spaceworker.top

echo '--- (a) GET /cyberlab (expect 200) ---'
A=$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" -m 25 "$BASE/cyberlab"); echo "A=$A"

echo '--- (b) GET /cyberlab/replay/<id> (expect 200 — NEW route) ---'
B=$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" -m 25 "$BASE/cyberlab/replay/$RID"); echo "B=$B"

echo '--- (c) GET artefacts API (expect 405/401/403, NOT 404) ---'
C=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$BASE/api/cyberlab/runs/$RID/artefacts"); echo "C=$C"

echo '--- (d) POST artefacts, no session (expect 401) ---'
D=$(curl -s -o /tmp/cy7-d.body -w '%{http_code}' -m 25 -H 'Content-Type: application/json' \
  -d '{"toolId":"mailer","content":"cy7-probe"}' "$BASE/api/cyberlab/runs/$RID/artefacts")
echo "D=$D body=$(head -c 160 /tmp/cy7-d.body 2>/dev/null)"

echo '--- (e) POST artefacts, session + foreign id (expect 403 or 404) ---'
E=$(curl -s -o /tmp/cy7-e.body -w '%{http_code}' -b "$CK" -m 25 -H 'Content-Type: application/json' \
  -d '{"toolId":"mailer","content":"cy7-probe"}' "$BASE/api/cyberlab/runs/$RID/artefacts")
echo "E=$E body=$(head -c 160 /tmp/cy7-e.body 2>/dev/null)"

echo '--- verdicts ---'
V=1
[ "$A" = 200 ] && echo 'a PASS' || { echo "a FAIL($A)"; V=0; }
[ "$B" = 200 ] && echo 'b PASS' || { echo "b FAIL($B)"; V=0; }
case "$C" in 405|401|403) echo 'c PASS';; *) echo "c FAIL($C)"; V=0;; esac
[ "$D" = 401 ] && echo 'd PASS' || { echo "d FAIL($D)"; V=0; }
case "$E" in 403|404) echo 'e PASS';; *) echo "e FAIL($E)"; V=0;; esac
[ "$V" = 1 ] && echo 'PROOF_DONE' || echo 'PROOF_FAILED'
BOX
tail -30 "$OUT"
