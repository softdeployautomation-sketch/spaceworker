-- Task 44 — allow a buyer who doesn't know how to find their transaction hash
-- to submit a payment without one. Postgres allows multiple NULLs under a
-- unique constraint, so this never collides between different no-hash rows.
ALTER TABLE "Payment" ALTER COLUMN "txHash" DROP NOT NULL;
