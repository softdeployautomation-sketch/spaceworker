# TASK_185 — MAINTENANCE SCREEN STICKS AFTER DEPLOY (poisoned client cache)

**Owner report (2026-10-08, verbatim):** "during the deployment when the website
got a maintenance screen. the exe shows this, and wont change even after
deployment. and it did that also to my account on the web app, but when i tried
incognito, it worked.. this is going to be an issue for wrapper user if their
device is showing this without showing their devices."

Screenshot evidence: SPA renders, two red errors `Unexpected token '<',
"<!DOCTYPE "... is not valid JSON` on `/api/devices` + install-link fetches,
"All (0) / No machines yet" despite real devices.

---

## ROOT CAUSE (confirmed 2026-10-08 — full chain traced)

**Incognito working = server healthy; the normal client is replaying a CACHED
maintenance response.**

Two maintenance mechanisms exist (both by design, Task 56):

1. **Mechanism 1 — nginx** (`/etc/nginx/sites-enabled/spaceworker.top.conf`,
   mirrored verbatim in `spaceworker.instaweb.top.conf`):
   - `deploy-vps.sh` touches `/var/www/sw-maintenance.on` before the build,
     removes it only after the app answers 200 → **every** request (document,
     `/api/*`, assets) is rewritten `rewrite ^ /maintenance.html last;`
   - plus `error_page 502 503 504 /maintenance.html;` for the literal restart
     window when nothing is listening.
   - **THE BUG:** `location = /maintenance.html` sets only
     `add_header X-Maintenance 1 always;` — **no `Cache-Control`**. nginx static
     serving emits `Last-Modified` + `ETag` (file mtime Sep 24 ⇒ age ~14 days
     ⇒ Chrome heuristic freshness ≈ **10% of age ≈ 1.4 days**). So a browser
     (and the wrapper's WebView) caches the maintenance HTML **for the request
     URL it was served for** — including `/api/devices` — with status 200, and
     replays it WITHOUT revalidating for up to ~1.4 days after the deploy
     ends. Every 20 s device-list poll re-reads the poisoned entry → the red
     errors are permanent, server logs show nothing (no request arrives).
2. **Mechanism 2 — proxy.ts web flag** returns `MAINTENANCE_PAGE_HTML` 503 with
   explicit `Cache-Control: no-store` ✓ (HTML branch already correct), and the
   **exeApi branch's JSON 503 (proxy.ts:154) has NO Cache-Control** (middleware
   responses are not guaranteed the next.config `headers()` treatment — the
   HTML branch's manual header is evidence the author knew).
3. next.config.ts already sets `no-store, must-revalidate` on `/api/:path*` —
   but **only when Next serves the response**. The 2026-09-25 comment documents
   this exact "Unexpected token '<'" failure for Next-side 500/502s; nginx is
   Mechanism 1 and never got the same treatment. That's the gap.

Why the wrapper matters: WebView = same Chromium cache rules ⇒ wrapper users
hit this on EVERY deploy, and they won't know to hard-refresh.

---

## STEPS

- [x] **S1 research** — traced both mechanisms, nginx conf on box, static file,
      next.config headers, proxy branches, device-list 20 s poll, no service
      worker exists (grep clean), no shared apiFetch helper (per-site fetch).
- [x] **S2 nginx fix (box)** — DONE 2026-10-08: `spaceworker.top.conf` +
      `spaceworker.instaweb.top.conf` (the ONLY two vhosts serving the page),
      `location = /maintenance.html` now emits
      `add_header Cache-Control "no-store, must-revalidate" always;` —
      `nginx -t` ok, reloaded. (These are the two `grep -l maintenance.html`
      hits; no other vhost serves it.)
- [x] **S3 proxy fix (repo)** — DONE: exeApi JSON 503 now sets
      `Cache-Control: no-store, must-revalidate` explicitly (parity with the
      HTML branch).
- [x] **S4 client self-heal (repo)** — DONE: 16 GET fetch sites pass
      `cache: "no-store"`: device-list `/api/devices` + `/api/assistant/vantra`
      (the 20 s poll = self-heal loop), device-console 10 (device row, the 7-URL
      tool-data batch, clone poll, mesh-urls), billing 4 (status ×2, checkout,
      topup limits). wallet-chip already had it; POSTs untouched (not
      cacheable). A poisoned tab recovers on its next tick, no hard refresh.
- [ ] **S5 tests** — new `tests/maintenance-cache.test.ts` static locks:
      proxy exeApi branch has no-store; device-list GETs pass no-store; lib
      maintenance HTML still has its reload-poller. (+ existing suites.)
- [ ] **S6 gates** — tsc 0 · eslint 0-new · new test + wrapper-cookie 6/6 +
      devices suite.
- [ ] **S7 deploy + LIVE EVIDENCE** — deploy-vps.sh (repo files) → then flag
      ON on box: `curl -sI /api/devices` must show `Cache-Control: no-store`
      + `X-Maintenance: 1` → flag OFF: JSON 200. Record raw headers.
- [ ] **S8 commit + steps update + report** — owner does ONE hard-refresh
      (Cmd+Shift+R) to purge their current poisoned entries; everything else
      self-heals. Note: entries already poisoned on OTHER pages die naturally
      within the ~1.4-day heuristic window (JS cannot purge HTTP cache).

## KNOWN LIMITS (accepted, documented)
- Already-poisoned non-devices-page entries on open tabs can't be purged from
  the server; devices page self-heals via S4, others die within heuristic TTL
  or on hard refresh. Prevention (S2) covers all future deploys.
- nginx conf is box-only (not version-controlled in repo) — this file IS the
  record; S2 evidence in S7 output.
