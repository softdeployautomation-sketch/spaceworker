# Task 56 — Admin-toggleable maintenance page for web + EXE, instead of raw errors during deploys

**Status: ready to build. Owner-requested 2026-09-21**, in the context of the domain-separation plan (`PLAN_DOMAIN_SEPARATION.md` in the sibling Vantra repo) — but this task stands alone and is worth building regardless of when/whether that plan executes: any deploy (which this session's own `HOW_WE_MOVE_FAST.md` playbook does via `npm run build && systemctl restart`) has a real window where a user hits a raw error instead of the app.

## What's requested

"Instead of showing 502 or error to users, lets have a page showing update is on the way, check back soon or wait some minutes, and make sure the page keeps reloading until the updates is cleared and the page loads the right page" — for both web and the EXE, admin-controllable, both platforms (SpaceWorker + Vantra — see the companion task in Vantra's repo, same design, own implementation).

## Two distinct failure modes — both need covering, they're not the same mechanism

1. **Deliberate, planned**: the admin knows a deploy is about to happen (or a domain/DNS change per the separation plan) and wants to proactively show "we're updating" BEFORE anything actually breaks. This needs an admin-toggleable flag the running app can check.
2. **The literal restart window**: during `systemctl restart spaceworker.service`, the Next.js process is briefly not listening on its port AT ALL. Nothing INSIDE the app (middleware, a DB flag check, anything running in the Node process) can respond during this exact window, because the process doesn't exist yet — only nginx (which stays up in front of it) can serve anything. This is what actually produces the raw "502 Bad Gateway" the owner is describing.

Building only #1 leaves the real 502 window from #2 completely uncovered — that's the actual gap right now. Both are needed.

## The fix

### Mechanism 1 — a real fallback for the restart window (nginx-level, covers mode 2)

Add `error_page 502 503 504 /maintenance.html;` (or an internal-redirect to a small static file nginx can serve without proxying anywhere) to the live nginx vhost, `deploy/nginx-spaceworker.conf`, pointing at a static HTML file that lives outside the Next.js app entirely (served directly by nginx, e.g. `/opt/spaceworker/static/maintenance.html` or similar) — this is the ONLY thing that can respond during the exact seconds the app process is down. Keep it deliberately simple/static (no build step, no dependency on the app being reachable): "We're updating — this page will reload automatically" + a small inline `<script>` that polls (e.g. `fetch(location.href, {cache:"no-store"})` every 3-5s) and calls `location.reload()` the instant a real response comes back (status 200, not another 502). This directly satisfies "keeps reloading until the update is cleared and the page loads the right page" for the actual outage window.

### Mechanism 2 — an admin-toggleable flag for planned maintenance windows (covers mode 1, app-level)

1. **Schema**: add `AdminSetting.maintenanceModeWeb Boolean @default(false)` and `AdminSetting.maintenanceModeExeApi Boolean @default(false)` — two separate flags, not one. They're the SAME backend today (web pages and the EXE's API calls are served from one deployment), but keeping them separate now means the code is already correct once the domain-separation plan actually splits EXE-API traffic onto its own hostname — don't collapse them into one flag just because they're equivalent today.
2. **Admin UI**: a toggle for each flag (2 switches: "Web maintenance mode" / "EXE API maintenance mode") somewhere sensible in `app/admin/(protected)/admin-panel.tsx` — the Services tab is probably the right home, next to the existing worker start/stop controls (Task 48's `WorkerControlPanel`) since this is the same category of "operator flips a switch before/during risky work."
3. **Enforcement — `proxy.ts`**: near the top, before the existing session-scope logic, check `maintenanceModeWeb`. If true, serve the SAME maintenance page/response as Mechanism 1 for everything EXCEPT `/admin/**` (the admin must always be able to reach the toggle to turn it back off — never lock yourself out) and static assets. **Don't hit the DB on every single request to check this** — `getAdminSettings()` has no caching today; add a short in-memory TTL cache (5-10s is plenty — this doesn't need to be instant, it needs to not add a DB round-trip to every page view) so flipping the toggle takes effect within a few seconds, not immediately, which is a fine tradeoff here.
4. **EXE-API flag enforcement**: the `/api/exe/*` and `/api/exe-license/*` route groups should check `maintenanceModeExeApi` (same cached-read pattern) and return a distinguishable response (e.g. `503` with `{maintenance: true}` in the body) rather than proceeding — this is what the EXE-side client code (below) watches for.

### Mechanism 3 — the EXE's own client-side handling

The EXE doesn't render server HTML pages for its hosted calls — it makes `fetch()` calls from its own bundled UI (`LicenseGate`, `license-activation-form.tsx`, the extract/advanced-search flows, etc.) straight to `HOSTED_APP_URL`. A raw 502/network error or the new `{maintenance: true}` 503 from Mechanism 2 currently just surfaces as a generic error message in whichever component made the call — inconsistent, and doesn't retry automatically.

Add a small shared helper (e.g. `lib/hosted-fetch.ts`) that wraps calls to `HOSTED_APP_URL`: on a 502/503/network-level failure, show a shared "We're updating — retrying automatically" UI state (a small reusable component, not a full-page takeover unless the call was blocking something critical like the license gate itself) and retry on a backoff (a few seconds, capped) until it succeeds, then let the original call proceed as if nothing happened. Wire this into at least `LicenseGate`'s `status` check first (the highest-consequence one — a user shouldn't get stuck on a scary "licensing error" screen just because a deploy is mid-flight), then the other EXE-local routes that proxy to the hosted app as time allows.

## Verification expected

- `npx tsc --noEmit -p .` clean; migration applied for the new `AdminSetting` columns.
- Live: flip `maintenanceModeWeb` on via the new admin toggle, confirm a normal browser visit to the dashboard shows the maintenance page (not the real app), confirm `/admin/**` itself still works so the toggle can be flipped back off, confirm flipping it off makes the real page come back within the cache TTL with no manual action needed beyond what the page's own auto-reload script already does.
- Live: during an actual `systemctl restart spaceworker.service`, confirm a request made in that exact window gets the nginx-level maintenance page (Mechanism 1) instead of a raw browser 502, and confirm it auto-reloads into the real page once the restart completes.
- EXE: with `maintenanceModeExeApi` flipped on, launch the EXE (or trigger a license-status check) and confirm it shows the friendly retrying state instead of a raw error, and confirm it recovers automatically once the flag is cleared.
