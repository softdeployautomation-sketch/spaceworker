-- Task 45 — scoped license_only access. Add the single-use license-claim link
-- columns to ExeLicense so the "view my license" link emailed to an EXE buyer can
-- be resolved, given a real 7-day expiry, and marked consumed exactly once.
--
-- Only the SHA-256 hash of the token's random half is stored (never the raw
-- token). All three columns are nullable: rows created before this migration
-- have no claim link (those buyers reach /dashboard/licenses as real customers),
-- and PostgreSQL allows multiple NULLs under the unique constraint, so an empty
-- hash never collides.
ALTER TABLE "ExeLicense" ADD COLUMN "licenseClaimTokenHash" TEXT;
ALTER TABLE "ExeLicense" ADD COLUMN "licenseClaimTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "ExeLicense" ADD COLUMN "licenseClaimTokenConsumedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ExeLicense_licenseClaimTokenHash_key" ON "ExeLicense"("licenseClaimTokenHash");