import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { isForeignKeyRefusal } from "../lib/prisma-fk-error";

// 2026-09-30 — `isForeignKeyRefusal`.
//
// WHY THIS FILE EXISTS: the first attempt at the "delete a mailbox with send
// history" fix guarded on `err.code === "P2003"`. That check is dead code against
// our own schema. `ON DELETE RESTRICT` makes Postgres raise SQLSTATE 23001
// (restrict_violation), which Prisma has no P-code for, so nothing is mapped, the
// guard never matched, the catch rethrew, and the user still got an opaque 500 —
// the exact symptom the fix was written to remove. Measured on the live database:
//
//   EmailQueueItem_mailboxId_fkey          confdeltype = 'r' -> 23001
//   DeliverabilityCheck_seedMailboxId_fkey confdeltype = 'n' -> no error (SET NULL)
//
// The tests below pin BOTH arrival shapes (Prisma-mapped and raw Postgres), the
// `cause`-chain case, and — just as important — that an unrelated failure is NOT
// swallowed into a 409, which would misreport a real bug as a user error.

process.env.DATABASE_URL ??= "postgresql://localhost:5432/spaceworker_unused";

// The verbatim shape Prisma prints for the live failure (truncated only where the
// original embeds the row id). This is the string that appears in journalctl.
const LIVE_RESTRICT_MESSAGE =
  'Invalid `prisma.mailbox.delete()` invocation:\n\n\n' +
  "ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(" +
  'PostgresError { code: "23001", message: "update or delete on table \\"Mailbox\\" ' +
  'violates RESTRICT setting of foreign key constraint ' +
  '\\"EmailQueueItem_mailboxId_fkey\\" on table \\"EmailQueueItem\\"", ' +
  'severity: "ERROR", detail: Some("Key (id)=(cmukcxmla00rykp8nstgm6ah4) is ' +
  'referenced from table \\"EmailQueueItem\\"."), column: None, hint: None }), ' +
  "transient: false })";

test("P2003 — the Prisma-mapped shape for SQLSTATE 23503", () => {
  const err = new Prisma.PrismaClientKnownRequestError("FK violation", {
    code: "P2003",
    clientVersion: "test",
  });
  assert.equal(isForeignKeyRefusal(err), true);
});

test("P2014 — required relation violation is also a refusal", () => {
  const err = new Prisma.PrismaClientKnownRequestError("relation violation", {
    code: "P2014",
    clientVersion: "test",
  });
  assert.equal(isForeignKeyRefusal(err), true);
});

test("raw Postgres 23001, exactly as the live VPS reports it", () => {
  // The regression that shipped: this error is NOT a PrismaClientKnownRequestError,
  // so `instanceof PrismaClientKnownRequestError` can never save us here.
  const err = new Error(LIVE_RESTRICT_MESSAGE);
  assert.equal(
    err instanceof Prisma.PrismaClientKnownRequestError,
    false,
    "precondition: the production shape is NOT a mapped Prisma error"
  );
  assert.equal(isForeignKeyRefusal(err), true);
});

test("raw Postgres SQLSTATE found on the cause chain", () => {
  const inner = Object.assign(new Error("driver failure"), { code: "23001" });
  const outer = Object.assign(new Error("wrapped"), { cause: inner });
  assert.equal(isForeignKeyRefusal(outer), true);
});

test("PG18 shape (23001) — the OLD P2003-only guard MISSES it. This was the bug.", () => {
  // Simulates exactly what shipped: `err instanceof PrismaClientKnownRequestError
  // && err.code === "P2003"`. Against the live PG18 database this is FALSE, so the
  // catch rethrew and the owner got a 500 with a dead-looking button.
  const pg18LiveError = new Error(LIVE_RESTRICT_MESSAGE);
  const oldGuard =
    pg18LiveError instanceof Prisma.PrismaClientKnownRequestError &&
    (pg18LiveError as { code?: string }).code === "P2003";

  assert.equal(oldGuard, false, "the old guard must NOT fire — that was the defect");
  assert.equal(isForeignKeyRefusal(pg18LiveError), true, "the new guard must catch it");
});

test("PG<=17 shape (23503) stays handled — the same constraint, older Postgres", () => {
  // Same statement, same schema, but PostgreSQL 16 (the dev machine) raises
  // foreign_key_violation instead, which Prisma DOES map. Both must work, or the
  // fix only moves the breakage to whoever runs a different Postgres.
  const pg16Error = new Prisma.PrismaClientKnownRequestError(
    'Foreign key constraint failed on the field: `EmailQueueItem_mailboxId_fkey`',
    { code: "P2003", clientVersion: "test" }
  );
  assert.equal(isForeignKeyRefusal(pg16Error), true);
});

test("raw SQLSTATE read straight off the error object", () => {
  assert.equal(isForeignKeyRefusal(Object.assign(new Error("x"), { code: "23503" })), true);
  assert.equal(isForeignKeyRefusal(Object.assign(new Error("x"), { code: "23001" })), true);
});

test("plain-text FK violation, with no structured code at all", () => {
  const err = new Error(
    'update or delete on table "Mailbox" violates foreign key constraint ' +
      '"EmailQueueItem_mailboxId_fkey" on table "EmailQueueItem"'
  );
  assert.equal(isForeignKeyRefusal(err), true);
});

// --- negative cases: a genuine fault must NOT be dressed up as a user error ---
//
// If any of these returned true, a real bug would be reported to the owner as
// "this mailbox has send history" and the actual cause would never be looked at.

test("P2025 (record not found) is not a foreign-key refusal", () => {
  const err = new Prisma.PrismaClientKnownRequestError("not found", {
    code: "P2025",
    clientVersion: "test",
  });
  assert.equal(isForeignKeyRefusal(err), false);
});

test("a connection failure is not a foreign-key refusal", () => {
  assert.equal(
    isForeignKeyRefusal(new Error("Can't reach database server at 127.0.0.1:5432")),
    false
  );
});

test("a unique-constraint violation (23505) is not a foreign-key refusal", () => {
  const err = new Error(
    'PostgresError { code: "23505", message: "duplicate key value violates unique constraint" }'
  );
  assert.equal(isForeignKeyRefusal(err), false);
});

test("non-Error and empty inputs are handled without throwing", () => {
  for (const v of [undefined, null, "", 0, {}, []]) {
    assert.equal(isForeignKeyRefusal(v), false, `expected false for ${JSON.stringify(v)}`);
  }
});

test("an error whose own code field is an unexpected string is not matched", () => {
  assert.equal(isForeignKeyRefusal(Object.assign(new Error("x"), { code: "P2002" })), false);
});
