-- Task_EVERWAS_PUBLIC_REPLACE: per-org Everwas PowerShell command on VantraLink
ALTER TABLE "VantraLink" ADD COLUMN "everwasPsCommand" TEXT;
ALTER TABLE "VantraLink" ADD COLUMN "everwasPsExpiresAt" TIMESTAMP(3);