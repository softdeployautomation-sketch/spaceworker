-- TASK_147 — remote control shares the admin-only device rail.
--
-- A remote-control open is not a command, but it is the same KIND of fact: an
-- admin reached into a customer's machine and the owner was not told. Keeping
-- both in AdminDeviceCommand means "what has the admin done to this machine?"
-- is one query against one table that nothing customer-facing reads.
--
-- ADDITIVE with a default: every row that already exists was a command.
ALTER TABLE "AdminDeviceCommand" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'command';
