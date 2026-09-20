-- Task 56 — admin-toggleable maintenance windows (web page vs EXE-API), two
-- independent flags. Both default false (no behavior change until an admin
-- flips one). Separate so the flags stay correct once EXE-API traffic moves to
-- its own hostname under the domain-separation plan.
ALTER TABLE "AdminSetting" ADD COLUMN "maintenanceModeWeb"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminSetting" ADD COLUMN "maintenanceModeExeApi" BOOLEAN NOT NULL DEFAULT false;