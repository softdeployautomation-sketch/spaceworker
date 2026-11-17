#!/usr/bin/env bash
# TASK_209 functional proof (prompt §5-6): on the LIVE build,
#  a) POST /api/hosting/files with a .vbs file  -> must be 201 (allow-all restored)
#  b) POST with a .exe (no acknowledgeGated)     -> must be 4xx (gates still GATED)
#  c) DELETE the .vbs probe                      -> cleanup, no junk left
#  d) GET  https://spaceworker.top/cyberlab      -> slice-2 page answers
# Session minted exactly like lib/auth.ts (HS256, iss/aud 'spaceworker', cookie
# spaceworker_session) using the box SESSION_SECRET; run node from /opt/spaceworker
# so jose resolves from the service's node_modules. Log: /tmp/t209-functional.txt
set -u
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/t209-functional.txt
: > "$OUT"
log(){ echo "$@" >> "$OUT"; }
log '=== T209 functional proof ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 'bash -s' >> "$OUT" 2>&1 <<'BOX'
set -u
cd /opt/spaceworker || exit 1
U=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']$//" | tr -d '[:space:]')
# Prefer a user holding a hosting grant; fall back to tier 5 (premium catch-all).
PROBE_USER=$(psql "$U" -qAtc 'select u.id from "User" u join "UserEntitlement" e on e."userId"=u.id where e.key='"'"'hosting'"'"' and e."revokedAt" is null limit 1')
[ -z "$PROBE_USER" ] && PROBE_USER=$(psql "$U" -qAtc 'select id from "User" where tier=5 order by "createdAt" desc limit 1')
[ -z "$PROBE_USER" ] && { echo 'NO_ENTITLED_USER'; exit 1; }
echo "probe user=$PROBE_USER"
SECRET=$(grep -m1 '^SESSION_SECRET=' .env | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')
[ -z "$SECRET" ] && { echo 'NO_SESSION_SECRET'; exit 1; }
TOKEN=$(sudo -u trmm node -e '
const { SignJWT } = require("jose");
const key = new TextEncoder().encode(process.argv[2]);
(async () => {
  const t = await new SignJWT({ email: "t209-probe@localhost", emailVerified: true, scope: "full" })
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

echo '--- (a) .vbs upload (expect 201) ---'
printf 'WScript.Echo "t209-probe"\n' > /tmp/t209-probe.vbs
RESP=$(curl -s -w '\n%{http_code}' -H "Cookie: spaceworker_session=$TOKEN" \
  -F "file=@/tmp/t209-probe.vbs;filename=t209-probe.vbs" \
  http://localhost:3500/api/hosting/files)
echo "$RESP"
VBS_CODE=$(echo "$RESP" | tail -1)

echo '--- (b) .exe control without acknowledgeGated (expect 4xx) ---'
printf 'MZ fake exe probe' > /tmp/t209-probe.exe
RESP2=$(curl -s -w '\n%{http_code}' -H "Cookie: spaceworker_session=$TOKEN" \
  -F "file=@/tmp/t209-probe.exe;filename=t209-probe.exe" \
  http://localhost:3500/api/hosting/files)
echo "$RESP2"
EXE_CODE=$(echo "$RESP2" | tail -1)

echo '--- (c) cleanup: DELETE the .vbs probe ---'
FID=$(echo "$RESP" | head -1 | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin)["file"]["id"])
except Exception:
  print("")' 2>/dev/null)
if [ -n "$FID" ]; then
  DCODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Cookie: spaceworker_session=$TOKEN" "http://localhost:3500/api/hosting/files/$FID")
  echo "DELETE $FID -> $DCODE"
else
  echo 'NO_FILE_ID (upload failed — see above)'
fi

echo "VBS_CODE=$VBS_CODE"
echo "EXE_CODE=$EXE_CODE"
[ "$VBS_CODE" = "201" ] && echo 'VBS_ACCEPTED' || echo 'VBS_REJECTED'
case "$EXE_CODE" in 4*) echo 'EXE_GATE_HELD' ;; *) echo 'EXE_NOT_GATED' ;; esac
echo PROOF_DONE
BOX
log '--- public cyberlab route ---'
curl -s -o /dev/null -w 'https://spaceworker.top/cyberlab -> %{http_code}\n' --max-time 20 https://spaceworker.top/cyberlab >> "$OUT"
grep -E 'VBS_ACCEPTED|VBS_REJECTED|EXE_GATE_HELD|EXE_NOT_GATED|PROOF_DONE|-> ' "$OUT" | tail -8
log FUNCTIONAL_DONE