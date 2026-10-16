-- Referral Security (Hidden Login)
--
-- Adds:
--   * `ReferralLink` — one short-code link per user, used to gate /login /signup.
--   * `User.referredBy` / `User.referredByLinkId` — who referred a user + the link used.
--   * `PublicMessage` — unauthenticated support messages from the public homepage.
--   * `CaptchaChallenge` — server-verified clown CAPTCHA challenges.
--
-- Applied manually on the box (`prisma migrate deploy`) because
-- scripts/deploy-vps.sh runs `prisma generate` only — no `prisma migrate deploy`.

-- CreateTable
CREATE TABLE "ReferralLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReferralLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicMessage" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptchaChallenge" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "answerHash" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptchaChallenge_pkey" PRIMARY KEY ("id")
);

-- AlterTable — add referral attribution fields to User
ALTER TABLE "User" ADD COLUMN "referredBy" TEXT;
ALTER TABLE "User" ADD COLUMN "referredByLinkId" TEXT;

-- AddForeignKey
ALTER TABLE "ReferralLink" ADD CONSTRAINT "ReferralLink_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "User" ADD CONSTRAINT "User_referredByLinkId_fkey"
    FOREIGN KEY ("referredByLinkId") REFERENCES "ReferralLink"("id") ON DELETE SET NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ReferralLink_code_key" ON "ReferralLink"("code");
CREATE UNIQUE INDEX "ReferralLink_userId_key" ON "ReferralLink"("userId");
CREATE INDEX "ReferralLink_userId_idx" ON "ReferralLink"("userId");
CREATE INDEX "PublicMessage_createdAt_idx" ON "PublicMessage"("createdAt");
CREATE UNIQUE INDEX "CaptchaChallenge_token_key" ON "CaptchaChallenge"("token");
CREATE INDEX "CaptchaChallenge_expiresAt_idx" ON "CaptchaChallenge"("expiresAt");
