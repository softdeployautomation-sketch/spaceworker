-- Task 58 — email is now required to START a new trial (no more anonymous
-- first launch). Nullable at the DB level only for legacy rows created before
-- this field existed; every NEW row is written by a call that requires email,
-- and the first email-carrying request from a legacy device back-fills the
-- column. startedAt and email are both first-wins in the upsert (the same
-- "startedAt never resets" discipline), so a returning machine keeps its true
-- original start and its original identity.

ALTER TABLE "ExeTrialSession" ADD COLUMN "email" TEXT;