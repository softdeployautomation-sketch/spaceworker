-- Came-via (owner, 2026-10-16): which existing user this invite is attributed
-- to when the invitee redeems it at signup (drives "came via" in the admin
-- referral tree). Nullable → old invites simply have no attribution.
ALTER TABLE "InviteLink" ADD COLUMN "referredById" TEXT;
