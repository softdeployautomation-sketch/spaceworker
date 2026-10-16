-- Invite-only (Model C): personalized, admin-generated invites bound to a single
-- invitee email. Distinct from the per-user universal ReferralLink. Only the named
-- email may redeem (enforced in the signup route); anyone else is rejected.
-- Deliberately NOT owned by a User row — the admin is a separate JWT identity,
-- so invites are tracked in their own admin panel, never tied to a user account.
CREATE TABLE "InviteLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "inviteeEmail" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "redeemedAt" TIMESTAMP(3),
    "redeemedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteLink_pkey" PRIMARY KEY ("id")
);

-- One live invite per invitee email (re-inviting reuses the existing row).
CREATE UNIQUE INDEX "InviteLink_code_key" ON "InviteLink"("code");
CREATE UNIQUE INDEX "InviteLink_inviteeEmail_key" ON "InviteLink"("inviteeEmail");
CREATE INDEX "InviteLink_code_idx" ON "InviteLink"("code");
CREATE INDEX "InviteLink_inviteeEmail_idx" ON "InviteLink"("inviteeEmail");
