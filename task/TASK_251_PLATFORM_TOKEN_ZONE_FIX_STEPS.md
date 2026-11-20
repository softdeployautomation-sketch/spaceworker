# TASK_251 — Platform token zone listing + selector repair

Branch: `agent/task-251-token-zone-fix` (from `main` @ `b41c766`)
Schema: none
Deploy: CI-only (`Build & Deploy` on `main`). **Never deploy without the owner's 🚦 GO.**

## Status
PHASE 1 + PHASE 2 DONE. Both owner tokens now carry `Cloudflare Pages: Edit`
(re-probed 2026-11-02: `/pages/projects` → 200) and both production rows were
re-encrypted with the app's hex crypto and read back successfully. Phase 3
custom-domain wiring is NOT done (not requested). Deploy awaits 🚦 GO.

## Root causes (live evidence, 2026-11-02)
1. `admin-panel.tsx:2547` fetched `/api/admin/hosting/zones` → 404. The real route is
   `/api/admin/hosting?purpose=…`.
2. `GET /api/admin/hosting?purpose=sites&accountId=9bc97c44…` returned
   `canListZones:false, error:"Invalid access token"` because only the row's
   Workers token was tried. That token is dead; a readable, valid token exists in
   the same row's main slot.
3. `validateHostZone()` had the same single-token assumption, so Apply would 400.
4. Production rows were written by ad-hoc scripts using base64 for the encrypted
   columns while the app uses hex → "The stored token could not be read."

## Phase 1 — selector fix (this branch)
- [x] `credentials.ts`: add `readMainToken()` (mirror of `readWorkerToken`).
- [x] `route.ts`: `listZonesForAccount(accountId)` walks ALL roster rows for the
      account (priority order) and tries worker → main → zone tokens, skipping
      unreadable ones, until Cloudflare returns a zone list.
- [x] Use it in `handleZonesGet()` and `validateHostZone()`.
- [x] `admin-panel.tsx`: fetch `/api/admin/hosting?purpose=…`.
- [x] Tests: dead worker token falls through to main; all-dead fails closed and
      saves nothing; existing behaviours unchanged.

## Phase 2 — cleanup + data repair
- [x] Delete token-bearing scripts on the box:
      `/opt/spaceworker/add-token-prod.mjs`, `/opt/spaceworker/add-token-prod2.mjs`,
      `/tmp/add-token-prod.mjs`, `/tmp/add-token-prod2.mjs`.
- [x] Delete local untracked `scripts/add-cf-token.ts` (live token, broken import).
- [x] Re-encrypt both production rows with the app's hex crypto (main, Workers
      and Zones slots), clear `verifyError`, stamp `lastVerifiedAt`, and read the
      value back after the write. Rows: `cmus87os8001okp3rtblz8iqn`
      (`mainstreet.sbs`, hint 4967) and `cmvut0kvf0000kpyrens5n85n`
      (`mainstreet.work`, hint 0459). No token in git or docs.

## Phase 3 — Premium Sites on `mainstreetmint.sbs`
- [x] Pages-scoped tokens supplied (pages read now 200 for both).
- [ ] OPTIONAL / NOT REQUESTED: `resolveSiteHost()` is used only by tests; the
      deploy path publishes to `<project>.pages.dev`. Wire
      `<slug>.<siteDomain>` as a Pages custom domain only if the owner asks.

## Gate evidence (local, this branch)
- `npx tsc --noEmit` — clean (after deleting the untracked broken script).
- `npx eslint` on `credentials.ts`, `route.ts`, the new test — clean.
  `admin-panel.tsx` still has the same 42 pre-existing errors / 0 warnings as
  `HEAD`; the one-line URL fix adds none.
- `npx tsx --test tests/hosting-domain-selection-route.test.ts` — **9/9 pass**
  (3 new TASK_251 tests).
- `npx tsx --test tests/hosting-*.test.ts` — **406/406 pass**.

## Not proven / owner checks
- The deployed route has not yet been exercised against the real account; the
  production probe after deploy must show both zones for account `9bc97c44…`.
- Custom-domain publishing is deliberately out of scope (owner asked for
  selectability, not `<slug>.mainstreetmint.sbs` URLs).
