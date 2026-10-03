-- TASK_157 Phase 1 — the platform-premium domain registry.
--
-- Strictly ADDITIVE and behaviour-preserving: both domain dials default to the
-- EMPTY STRING, which the resolver reads as "premium is not configured yet, serve
-- the free Cloudflare host exactly as today". So applying this migration changes
-- nothing until an admin types a domain — the same safety property as
-- hostingEnabled=false.
--
--   hostingPremiumSiteDomain = the base zone premium SITES publish under, so a
--                              site lives at <slug>.<hostingPremiumSiteDomain>
--                              (e.g. my-site.instaweb.top) instead of the free
--                              <project>.pages.dev. MUST be a zone that lives in
--                              the SAME Cloudflare account as the Pages project,
--                              because a Pages custom domain is only auto-created
--                              when the zone is in-account (PLAN_TASK_157 §2.1).
--   hostingPremiumLinkDomain = the full HOST premium LINK redirects publish under
--                              (e.g. go.instaweb.top). It is a host, not a zone,
--                              because that is exactly what becomes the Worker
--                              route. Empty => links fall back to go.<zone>, and
--                              then to the account's *.workers.dev host.
ALTER TABLE "AdminSetting" ADD COLUMN "hostingPremiumSiteDomain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AdminSetting" ADD COLUMN "hostingPremiumLinkDomain" TEXT NOT NULL DEFAULT '';

-- The Workers.dev account subdomain we have CONFIGURED (e.g. "spaceworker").
-- Cloudflare scopes this to the ACCOUNT, not to a Worker, so it belongs on the
-- platform account row rather than on AdminSetting or on a single link. It is
-- public information (it is literally in the hostname), so it is stored plainly
-- and never treated as a secret. NULL = never set; Cloudflare's own value is the
-- tie-breaker. Changing it re-points every Worker in that account at once.
ALTER TABLE "HostingPlatformAccount" ADD COLUMN "workersDevSubdomain" TEXT;
