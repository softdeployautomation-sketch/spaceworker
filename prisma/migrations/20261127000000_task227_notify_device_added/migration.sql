-- TASK_227 — new-device-added notification pref (User.notifyDeviceAdded).
-- ADD-COLUMN-ONLY by design: one BOOLEAN NOT NULL with a server-side DEFAULT on
-- an existing table. Every existing row is backfilled by the DEFAULT in the
-- same statement — no data rewrite, no table/index/FK touched, so it cannot
-- break unrelated tables. (House pattern — see 20261125000000_task169_email_*.)

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyDeviceAdded" BOOLEAN NOT NULL DEFAULT true;