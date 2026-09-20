# Task 53 — `INTERNAL_BEARER_TOKEN` check fails open if the env var is ever unset; internal routes have no nginx-level restriction either

**Status: ready to build. Found during a security audit, 2026-09-20. Lower likelihood, real if it ever triggers.**

## The real gap, confirmed live in code (not assumed)

Every `/api/internal/*` route (`dispatch`, `mail-queue-drain`, `automations-sweep`, `retention-sweep`, `payment-verify`, `browser-profiles/[id]/acquire`, `browser-profiles/[id]/release`) gates itself the same way, e.g. `app/api/internal/dispatch/route.ts:77`:

```ts
const auth = req.headers.get("authorization");
if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
```

If `INTERNAL_BEARER_TOKEN` is ever unset on the server (a blank `.env` line, a deploy that drops the var, a fresh environment before secrets are provisioned), `process.env.INTERNAL_BEARER_TOKEN` is `undefined` and the template literal becomes the literal string `"Bearer undefined"`. Any request carrying the header `Authorization: Bearer undefined` then passes the check — a trivial, guessable bypass. This is the opposite of the fail-closed discipline this codebase otherwise holds itself to everywhere else: `lib/admin-auth.ts`'s `verifyAdminPasscode` explicitly checks `if (!expected || expected.trim().length === 0) return false` before ever comparing, and `worker/api.py` hard-`SystemExit`s if it isn't bound to `127.0.0.1`. The internal-route bearer check has no equivalent explicit "reject if the configured secret is empty" guard — it just happens to be safe today only because the token is in fact set.

Separately: `deploy/nginx-spaceworker.conf` has no `location` block for `/api/internal/*` — everything not matching the `/browser/` or agent/campaign regex falls through to the catch-all `location /` (lines 63–75), which proxies to the app with no additional restriction. So these routes ARE reachable from the public internet at `https://spaceworker.instaweb.top/api/internal/dispatch` etc., relying entirely on the app-level bearer check as the only defense — no defense-in-depth at the network layer, unlike the Python worker (`worker/api.py`), which is verified bound to `127.0.0.1` only.

## The fix

1. Add an explicit non-empty check before the comparison in every `/api/internal/*` route (or, better, factor it into one shared helper e.g. `lib/internal-auth.ts` with a `requireInternalBearer(req)` function, mirroring `requireAdminSession()`'s shape) — reject immediately if `process.env.INTERNAL_BEARER_TOKEN` is missing or empty, never fall through to the string comparison.
2. Add an nginx `location ~ ^/api/internal/` block that restricts access to `127.0.0.1` (`allow 127.0.0.1; deny all;`) alongside the existing bearer-token check, so a misconfigured/blank token doesn't become a public-internet-reachable bypass. Update `deploy/nginx-spaceworker.conf` (the reference copy) and the live VPS config together, per that file's own stated discipline of keeping the two in sync.

## Verification expected

- Temporarily unset `INTERNAL_BEARER_TOKEN` in a test environment; confirm the shared helper now rejects every request outright rather than accepting `Authorization: Bearer undefined`.
- After the nginx change, confirm `curl https://spaceworker.instaweb.top/api/internal/dispatch` from outside the VPS gets rejected at the network layer (connection refused/403) rather than reaching the app at all.
