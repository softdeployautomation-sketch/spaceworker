-- Task 99 / plan §COMMERCIAL C3 — module store price fields, plus the new
-- "SpaceWorker Agent" EXE product (owner, 2026-09-26). All nullable-free
-- Floats with defaults, matching the style of every existing *PriceUsd
-- column — placeholder launch prices the owner sets for real in
-- Admin > Wallets & Prices.
ALTER TABLE "AdminSetting" ADD COLUMN "extractorModulePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 9;
ALTER TABLE "AdminSetting" ADD COLUMN "mailerModulePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 9;
ALTER TABLE "AdminSetting" ADD COLUMN "assistantDevicesModulePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 15;
ALTER TABLE "AdminSetting" ADD COLUMN "agentExePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 50;
