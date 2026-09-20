-- Task 49 security fix: a device-transfer confirmation code reuses
-- VerificationCode instead of a new table, scoped by purpose so it can
-- never collide with (invalidate, or be invalidated by) an unrelated
-- pending signup-verification code for the same user. Every existing row
-- is a real signup code, hence the default.

-- AlterTable
ALTER TABLE "VerificationCode" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'signup';
