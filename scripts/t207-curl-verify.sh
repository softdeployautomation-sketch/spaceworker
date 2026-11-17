#!/usr/bin/env bash
set -u
rm -f /tmp/t207-cookies.txt
code=$(curl -s -c /tmp/t207-cookies.txt -o /tmp/t207-login.json -w '%{http_code}' \
  -X POST https://spaceworker.top/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"myrate619@gmail.com","password":"TestUser123"}')
echo "login: $code"
code=$(curl -s -b /tmp/t207-cookies.txt -o /tmp/t207-mesh.json -w '%{http_code}' \
  'https://spaceworker.top/api/devices/cmue4j31p007fkphthdgdovtd/mesh-urls')
echo "customer mesh-urls: $code"
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/t207-mesh.json'))
except Exception as e:
    print('parse fail:', e, open('/tmp/t207-mesh.json').read()[:300]); raise SystemExit
def scrub(o):
    if isinstance(o, dict):
        return {k: ('<redacted>' if any(s in k.lower() for s in ('token','url','hash','secret')) else scrub(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub(x) for x in o]
    return o
print(json.dumps(scrub(d), indent=1)[:900])
PY
rm -f /tmp/t207-cookies.txt /tmp/t207-login.json /tmp/t207-mesh.json
echo CLEANED
