-- TASK_181 P3 (step 25) — the XDevice wrapper premium price.
--
-- Owner: "$500 for the wrapper" — one admin-adjustable price field on the
-- singleton AdminSetting row (Admin > Wallets & Prices / /api/admin/wallets
-- pick it up automatically via ALL_PRODUCTS). Default 500 = the stated price.
--
-- NO term/duration column on purpose: the tier-3 term lives in
-- User.premiumExpiresAt (PREMIUM_DAYS_PER_CHARGE) and its length is never
-- rendered in the UI (owner: "never show it on ui how long the premium is
-- for"); the admin grant route decides/extends the term server-side.
--
-- ADDITIVE only: one NOT NULL column with a default; no existing row rewritten.

ALTER TABLE "AdminSetting" ADD COLUMN "xdevicePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 500;