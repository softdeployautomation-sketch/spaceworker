-- TASK_155 P4 — premium link cap (PLAN §17.2): "the links redirect should be able
-- to use the premium same with the file". Purely ADDITIVE: one AdminSetting column,
-- NOT NULL DEFAULT 500. Applying this rewrites NO existing row and changes NO
-- existing behaviour — free users keep hostingFreeMaxLinks (50) until
-- resolveHostingCaps starts reading this field for premium accounts.
--
--   * hostingPremiumMaxLinks — per-user short-link ceiling for premium accounts. 500.

-- AlterTable
ALTER TABLE "AdminSetting" ADD COLUMN "hostingPremiumMaxLinks" INTEGER NOT NULL DEFAULT 500;
