# Migration lock — 20261119000000_task187_invoice_days_thread_ref

**First LOCK.md in this repo — this file defines the convention.** The house rule
is "no local Postgres → migration SQL is written BY HAND", and a hand-written
migration needs a hand-written record of exactly what it claims to do, so a
reviewer (or a compaction) can verify it without diffing live databases.

## What this migration is allowed to touch

| Statement | Target | Type |
|---|---|---|
| `ADD COLUMN "days" INTEGER` | `PremiumInvoice` | additive, nullable |
| `ADD CONSTRAINT PremiumInvoice_days_check` | `PremiumInvoice` | new CHECK only |
| `ADD COLUMN "invoiceId" TEXT` | `SupportMessage` | additive, nullable, no FK |

- **Nothing existing is modified or dropped** — no `ALTER COLUMN`, no `DROP`,
  no backfill. Existing rows are valid as-is (`days` NULL = standard term).
- `invoiceId` is a SOFT reference by design: no FK, so no constraint name to
  keep in sync with Prisma's expectations.
- Schema parity: `prisma/schema.prisma` gained exactly `days Int?` on
  `PremiumInvoice` and `invoiceId String?` on `SupportMessage` in the same
  commit as this folder.

## Ordering / deploy

- Sorts NEWER than every migration currently on origin/main
  (newest was `20261118000001_task184_payment_invoice_ref`), so
  `prisma migrate deploy` applies it last, once, on the box:
  `sudo -u trmm npx prisma migrate deploy` → `npx prisma generate` → build
  (HOW_WE_MOVE_FAST §3 → §2). Deploy does NOT auto-migrate.
- Reverts are intentionally absent: additive nullable columns need no down
  migration (dropping them would destroy money evidence — `days` on paid
  invoices and the thread linkage).