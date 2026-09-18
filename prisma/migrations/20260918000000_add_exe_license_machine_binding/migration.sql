-- Task 47 — lock an EXE license to a single machine via a one-time "claim" step.
--
-- Issuance still produces an UNBOUND key (a purchase reference the EXE must not
-- accept). A claim re-signs that key with the buyer's device machine_id and
-- records the binding here, so the already-shipped offline validator can enforce
-- one-device. All four columns are nullable by design: every pre-existing row
-- (issued before this feature) correctly reads as "unclaimed" — no machine info
-- was ever bound for them either.

ALTER TABLE "ExeLicense"
    ADD COLUMN "boundMachineId"    TEXT,
    ADD COLUMN "boundMachineLabel" TEXT,
    ADD COLUMN "boundLicenseKey"   TEXT,
    ADD COLUMN "boundAt"           TIMESTAMP(3);