# TASK_249 — Platform domain selectors (Cloudflare zones)

Branch: `agent/task-249-platform-domain-selectors` (from `main` @ `b9e9feb`)
Schema: `20261204000000_task249_platform_domain_selectors` (additive only)

## Status
IMPLEMENTED + SENIOR-VERIFIED (this pass fixed the defects found). Ready for the
owner's deploy GO. Deploy is CI-only (`Build & Deploy` on `main`) and MUST NOT be
triggered without the owner's explicit GO.

The first delivery claimed "gates: DONE" with everything green. That was **false**:
at delivery the branch broke 6 pre-existing hosting test files and shipped a
scheme-less file base URL. The corrections are listed under "Defects found and
fixed". Nothing below is aspirational — every claim is backed by the commands in
"Gate evidence".

## Owner decisions (locked)
- The Worker proxy serves exactly `/hf/*` and `/link/vantra/*`; files and the
  installer share ONE public host.
- Each purpose's dropdown lists only zones of that purpose's pinned account.
  No auto-repointing.
- Files/installer has its own pin, defaulting to the **premium LINKS** pin (not
  sites). Resolution: files pin → links pin → priority rotation.

## Scope (as built)
- Schema: `AdminSetting.hostingPublicLinkHost String?` (shared host for `/hf/*` +
  `/link/vantra/*`) and `AdminSetting.hostingPublicLinksAccountId String?`.
  Migration is additive `ALTER TABLE … ADD COLUMN` only.
- `GET /api/admin/hosting?purpose=links|sites|public[&accountId=<id>]` returns
  `{accountId, label, zones, canListZones, error}`. `requireAdminSession`.
  Tokens are never serialized (asserted in a test).
- Server validation on PATCH: the host must sit under an active zone of the
  pinned account that WILL be stored (an account + host change in one Apply
  validates against the new pin). Sites must be the zone apex; links/public must
  be `label.apex` (one label under the zone). `*.workers.dev` is allowed for the
  premium-link dev host (TASK_157 Phase 3) with no zone check. Mismatch = 400
  naming the account, and nothing is written.
- Provision-before-save: for the public host, `provisionPublicHost()` runs BEFORE
  the upsert. A failed provision returns 400 with `provisionResult` and stores
  nothing. On success the old host's route is torn down AFTER the save, with the
  OLD pin; a failed teardown returns a `warning` (the save still stands).
- `lib/hosting/public-bases.ts`: `getFileBaseUrl()` / `getPublicLinkHost()` read
  `AdminSetting.hostingPublicLinkHost` per request behind a 60s module cache.
  The setting stores a HOST; both getters return a **full `https://` base URL**
  because every caller concatenates a path. Empty → env fallback
  (`HOSTING_PUBLIC_BASE_URL` / `PUBLIC_LINK_BASE_URL`, then `APP_BASE_URL`).
  A failed settings read falls back to env and caches the miss — a DB/settings
  problem can never break file serving.
- `lib/hosting/domain-select.ts` (new, pure): `resolvePurposeAccount`,
  `normalizeHostInput`, `zoneMatchesHost`, `hostForZone`, `apexOfHost`.
- `lib/hosting/public-proxy.ts`: `provisionPublicHost(host, {accountId})` =
  ensureZoneActive → proxied AAAA record (`100::`) → upload script
  `sw-public-proxy` → route `<host>/*`. `teardownPublicHost(host, {accountId})`
  deletes the route then the script. Idempotent. The Worker forwards only the two
  prefixes to `APP_BASE_URL`, preserves the query string, drops the client `Host`
  header, uses `redirect: "manual"`, streams the body, else 404.
- UI (`admin-panel.tsx`): three rows (Premium links / Premium sites / Files &
  installer) with account pin, zone dropdown, editable label (`go` / `dl`), Apply,
  Clear, and the provision result for the row that was just applied. Sites show
  the SSL-depth warning computed server-side.
- Wiring: `providers.ts` (local + future external `publicUrl`), `vantra-link.ts`
  (`mintInstallLink` + resolve view), `/api/hosting/status` (`publicBase` = file
  base; `linksBase` stays `env.publicLinkBaseUrl` because the proxy forwards only
  `/hf/*` and `/link/vantra/*`, so `/r/<slug>` must not move).

## Defects found and fixed in verification
1. `public-bases.ts` imported `lib/env` (and through `providers.ts` pulled
   `lib/prisma`/`server-only`) into the module graph of six pre-existing hosting
   tests → `DATABASE_URL`/`server-only` failures. Rewritten to be import-safe:
   dynamic `import("@/lib/admin-settings")`, env read lazily, test seam
   `setPublicBaseSettingsReader()`.
2. `resolvePublicBase()` returned a scheme-less bare host, so every `/hf/` and
   installer link on a configured host was broken. Now returns `https://<host>`.
3. Public pin fell back to the SITES pin. Owner decision is the LINKS pin. Fixed.
4. `publicAccountPin` was not exported, and `provision/teardown` had no account
   override, so a host could be provisioned in the wrong account. Added
   `accountId` options and threaded them through.
5. Proxy Worker built the upstream URL from `path` only (lost the query string)
   and forwarded the client `Host` header. Fixed, with snapshot assertions.
6. PATCH saved the setting before provisioning it (a broken host could be
   stored). Reordered to provision-then-save, teardown-after-save with the old
   pin.
7. Domain validation used the OLD account when account + host changed in one
   Apply, and guessed "last two labels" instead of matching the live zone list.
   Now merges the incoming pin over the saved row and suffix-matches real zones
   (works for `example.co.uk`).
8. `/api/hosting/status` pointed `linksBase` at the file base, which would 404
   `/r/<slug>` on the proxy host. Reverted to `env.publicLinkBaseUrl`.
9. Panel: fragile "was this my provision" heuristic replaced by the `field` in
   `provisionResult`; zone refetch on account change; blank account option
   ("Same as premium links" / "Automatic (priority order)"); Clear action;
   dead `PREMIUM_DOMAIN_ROWS` removed; no new lint findings.
10. `tests/vantra-link-installer.test.ts` A2 guard asserted `env.publicLinkBaseUrl`
    is the installer link source; TASK_249 intentionally moved it to
    `getPublicLinkHost()`. The guard now still forbids `env.appBaseUrl` and
    requires the resolver.

## Gate evidence (local, this branch)
- `npx tsc --noEmit` — clean.
- `npx eslint` on every touched source file — clean. `admin-panel.tsx` has the
  same 42 pre-existing errors / 0 warnings as `HEAD` (verified by linting the
  `HEAD` copy side by side); we added none.
- Hosting suite: 17 files, **402 pass / 0 fail**.
- Full `npm test`: **1893 tests, 1875 pass, 17 fail, 1 skip**. All 17 failures are
  the pre-existing set (`task-227`, `task-234`, `task-236`, `task-238`,
  `vantra-link-installer` TASK_179, device-list offline copy). Baseline at
  `b9e9feb` was 1846 pass / 17 fail / 1 skip; the +29 passes are the new tests.
- New tests: `tests/hosting-domain-select.test.ts` (7),
  `tests/hosting-domain-selection-route.test.ts` (6, including mismatch 400,
  validate-against-new-pin, provision-before-save, provision-failure-saves-
  nothing, teardown-after-save, zones-never-leak-a-token),
  `tests/hosting-public-bases.test.ts` (7), plus the extended
  `tests/hosting-public-proxy.test.ts` (9, incl. pin fallback and proxy source).

## Not proven here (owner / live checks)
- Migration on the live DB: the CI deploy runs `prisma migrate deploy`. Local
  runs have no Postgres, so the SQL was reviewed by eye only.
- Cloudflare reality (probed 2026-10): only the `New Prod` account token can list
  zones (`broks.beauty`, `instaweb.top`, `mainaccess.top`). `hosting Premium
  Links` (`43b24dc0…`) currently has **0 zones**, and **no** available token can
  create a zone (all 403 `com.cloudflare.api.account.zone.create`). The owner must
  add the chosen domain (e.g. `mainstreetmint.sbs`) to the pinned account before
  the files/installer host can be provisioned.
- Workers Free response cap (~100 MB): a large `/hf/` body proxied through the
  Worker may fail. The documented fallback remains `HOSTING_PUBLIC_BASE_URL`
  (direct host), and clearing the shared host returns to it.
- Live HTTP reachability of the provisioned host (DNS propagation + certificate).

## Open / follow-ups
- TASK_250 (mailbox SMTP vs Zoho Mail API OAuth) is scoped next, not part of this
  branch.
- Mobile Cyber Lab UI cleanup is unscoped/unapproved.
