-- Soft-delete for BrowserSession: a customer "deleting" an ended session from
-- their own history hides it, but the row stays intact for the admin audit
-- endpoint (app/api/admin/browser-sessions), which has no other record of
-- past sessions. Additive, defaults null (visible) for all existing rows.
ALTER TABLE "BrowserSession" ADD COLUMN "hiddenAt" TIMESTAMP(3);
