# PLAN — Debug mainstreetpay.help ERR_SSL_PROTOCOL_ERROR

## Current state (box-verified via curl)
- `https://lucky-king-f5d3.myrate619.workers.dev/` → TLSv1.3 OK, HTTP/2 200 ✅
- `https://mainstreetpay.help/` → `tlsv1 alert internal error` ❌ (SSL handshake fails at Cloudflare edge)
- DNS: `mainstreetpay.help` → Worker `lucky-king-f5d3`, Proxy status = Proxied (orange cloud) ✅
- SSL/TLS mode: Full ✅
- Edge Certificates: Advanced + Universal for `*.mainstreetpay.help, mainstreetpay.help` both "Active", expires 2027-02-06 ✅
- Root cause: certificate is "Active" in dashboard but not deployed to the edge nodes handling `mainstreetpay.help`

## Fix (no code changes needed — Cloudflare dashboard action)
1. Go to Workers & Pages → `lucky-king-f5d3` → Settings → Domains & Routes
2. Remove custom domain `mainstreetpay.help`
3. Wait ~1 minute
4. Click Add Domain → re-add `mainstreetpay.help` (Production)
5. Wait 5–15 minutes for edge certificate propagation
6. Verify: `curl -v https://mainstreetpay.help/cdn-cgi/trace` should return 200 with Cloudflare data

## Verification
- `curl -v https://mainstreetpay.help/` → TLS handshake completes, HTTP/2 200
- `https://mainstreetpay.help/cdn-cgi/trace` loads in browser

## Playbook refs
- PROMPT_SENIOR_VERIFICATION_AGENT.md §1 (deploy/verify authority)
- HOW_WE_MOVE_FAST.md §0 (access), §4 (verification gates)
- PROMPT_NEXT_VERIFICATION_AGENT.md §2 (baseline, honest unverified list)
