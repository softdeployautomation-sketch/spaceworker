-- Task 46 — admin admission control for the two locally RAM-heavy mechanisms
-- (search/extraction dispatch lanes, interactive browser sessions). Defaults
-- match today's hardcoded behavior exactly (1 per dispatch lane, 3 browser
-- sessions) — purely additive, zero behavior change until an admin touches one.
ALTER TABLE "AdminSetting" ADD COLUMN "dispatchLightEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminSetting" ADD COLUMN "dispatchLightMaxConcurrent" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdminSetting" ADD COLUMN "dispatchHeavyEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminSetting" ADD COLUMN "dispatchHeavyMaxConcurrent" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdminSetting" ADD COLUMN "browserSessionsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminSetting" ADD COLUMN "browserSessionsMaxConcurrent" INTEGER NOT NULL DEFAULT 3;
