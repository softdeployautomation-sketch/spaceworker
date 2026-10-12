-- TASK_203 — register the XDevice Monitor product's price field.
--
-- ADDITIVE ONLY: one ADD COLUMN ... NOT NULL DEFAULT 0 on AdminSetting. No
-- existing row, column, constraint or index is dropped, altered or renamed.
-- Same shape as xdevicePriceUsd (20261118000000_task181_xdevice_price).

-- AlterTable
ALTER TABLE "AdminSetting" ADD COLUMN     "deviceMonitorExePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;