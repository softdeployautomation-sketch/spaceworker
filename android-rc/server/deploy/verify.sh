#!/usr/bin/env bash
# deploy/verify.sh — regression pins + health checks (T254-B)
# Run after deploy. Does not modify anything.
set -euo pipefail

DOMAIN="android.spaceworker.top"
BOX_IP="207.244.224.57"

echo "=== T254-B verify.sh ==="

# 1. DNS matches box IP
RESOLVED=$(dig +short "$DOMAIN" A | head -1)
echo "DNS $DOMAIN -> $RESOLVED (expect $BOX_IP)"
[ "$RESOLVED" = "$BOX_IP" ] && echo "PASS: DNS" || echo "FAIL: DNS mismatch"

# 2. /api/health
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" || echo "000")
BODY=$(curl -s "https://$DOMAIN/api/health" || echo '{}')
echo "HTTP /api/health = $CODE  body=$BODY"
[ "$CODE" = "200" ] && echo "PASS: health" || echo "FAIL: health"

# 3. 8883 TLS handshake
openssl s_client -connect "$DOMAIN:8883" -servername "$DOMAIN" </dev/null 2>/dev/null | grep -q 'Verify return code' && echo "PASS: 8883 TLS" || echo "FAIL: 8883 TLS"

# 4. Viewer loads
CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || echo "000")
echo "HTTP / = $CODE"
[ "$CODE" = "200" ] && echo "PASS: viewer" || echo "FAIL: viewer"

# 5. Regression pins — spaceworker.top unchanged
CODE_ROOT=$(curl -s -o /dev/null -w '%{http_code}' https://spaceworker.top/ || echo "000")
CODE_LOGIN=$(curl -s -o /dev/null -w '%{http_code}' https://spaceworker.top/login || echo "000")
echo "spaceworker.top/ = $CODE_ROOT (expect 200)  /login = $CODE_LOGIN (expect 307)"
[ "$CODE_ROOT" = "200" ] && echo "PASS: root pin" || echo "FAIL: root pin"
[ "$CODE_LOGIN" = "307" ] && echo "PASS: login pin" || echo "FAIL: login pin"

echo "=== verify.sh done ==="