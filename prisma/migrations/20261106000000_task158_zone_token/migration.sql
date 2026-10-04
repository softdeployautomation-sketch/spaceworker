-- TASK_158 W0 — the ZONES token, the THIRD Cloudflare credential on the platform
-- roster.
--
-- Purely ADDITIVE and NULLABLE, exactly like the P6c Workers token before it: no
-- existing row is rewritten, no column is NOT NULL, and a NULL zone token is the
-- NORMAL state rather than an error. That is deliberate — a zero-write permission
-- probe across all three of our Cloudflare accounts (5 tokens) found that every
-- one is REFUSED zone creation with
-- `403 com.cloudflare.api.account.zone.create`, so today no row can create zones
-- and the feature degrades to the manual two-step path instead of failing.
--
-- The token is scoped and stored SEPARATELY on purpose. Widening the Pages or
-- Workers token to reach zones would give every single site deploy a
-- zone-administration credential; a third narrow token grants zone create/DNS to
-- one caller only. The owner's stated goal — paste it once per account and have
-- it work for the three existing accounts AND any future one — is why this lives
-- on the account row rather than in a global setting.
--
-- AES-256-GCM encrypted with the same MAILBOX_ENCRYPTION_KEY helpers as the other
-- two tokens, never plaintext, and never returned by any route: the views expose
-- only `zoneTokenHint` (last 4 chars).

-- AlterTable
ALTER TABLE "HostingPlatformAccount" ADD COLUMN "zoneTokenCiphertext" TEXT,
ADD COLUMN "zoneTokenIv" TEXT,
ADD COLUMN "zoneTokenTag" TEXT,
ADD COLUMN "zoneTokenHint" TEXT NOT NULL DEFAULT '',
ADD COLUMN "zoneTokenError" TEXT;