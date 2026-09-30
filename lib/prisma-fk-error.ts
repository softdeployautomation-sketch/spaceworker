import { Prisma } from "@prisma/client";

// A delete that a foreign key refuses reaches a route in one of two shapes, and
// which one you get depends on your POSTGRES VERSION — not on your code, your
// schema, or the constraint's action. That is what made this bug invisible to
// local testing:
//
//   PostgreSQL <= 17 : `ON DELETE RESTRICT` raises SQLSTATE **23503**
//                      (foreign_key_violation) -> Prisma maps it to
//                      PrismaClientKnownRequestError "P2003".
//   PostgreSQL >= 18 : the SAME `ON DELETE RESTRICT` raises SQLSTATE **23001**
//                      (restrict_violation), which has NO Prisma P-code at all,
//                      so it arrives as a raw PrismaClientUnknownRequestError
//                      whose message embeds `PostgresError { code: "23001", ... }`
//                      and whose user_facing_error is None.
//
// Measured directly, same schema, same constraint, same statement:
//
//   LOCAL dev  PG 16.15 : SQLSTATE=23503 | violates foreign key constraint
//   LIVE  VPS  PG 18.6  : SQLSTATE=23001 | violates RESTRICT setting of foreign key constraint
//
// So a guard of `err.code === "P2003"` is correct on the dev machine and dead
// code in production: the catch rethrows, and the caller gets an opaque 500. That
// is exactly the "I deployed it and the button still does nothing" report this
// module exists to fix, and no amount of local testing could have caught it.
//
// Both SQLSTATEs mean the same thing to a caller — "rows exist that depend on
// this one" — so they are treated as one condition. Kept deliberately narrow:
// anything not positively identified is NOT a foreign-key refusal, so a genuine
// fault still surfaces as a 500 rather than being mislabelled as a 409.
//
// The LIVE_RESTRICT_MESSAGE fixture in tests/prisma-fk-error.test.ts is the real
// PG18 string; if this module is ever "simplified" back to a P2003 check, that
// test fails on the exact error the owner is looking at.
const FK_PRISMA_CODES: readonly string[] = ["P2003", "P2014"];
const FK_SQLSTATE_CODES: readonly string[] = ["23001", "23503"];

// The raw-Postgres shape, as Prisma formats it into the message:
//   ConnectorError(ConnectorError { user_facing_error: None, kind:
//     QueryError(PostgresError { code: "23001", message: "...", ... }) })
const EMBEDDED_SQLSTATE = /\bcode:\s*"(23001|23503)"/;

// The human-readable half. PG18 words RESTRICT as "violates RESTRICT setting of
// foreign key constraint" while PG<=17 says "violates foreign key constraint" —
// both are matched, so this still holds if the driver reports the text without
// the structured code.
const FK_VIOLATION_TEXT =
  /violates\s+(?:RESTRICT\s+setting\s+of\s+)?foreign\s+key\s+constraint/i;

/**
 * True when `err` is a database foreign key refusing a write — either because
 * Prisma mapped it (P2003/P2014) or because it arrived raw from Postgres
 * (SQLSTATE 23001 RESTRICT, or 23503 FK violation).
 *
 * Walks the `cause` chain because the SQLSTATE can sit on a wrapped error
 * rather than the object caught by the caller.
 */
export function isForeignKeyRefusal(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (FK_PRISMA_CODES.includes(err.code)) return true;
  }

  const seen = new Set<unknown>();
  let node: unknown = err;
  for (let depth = 0; depth < 6; depth++) {
    if (!node || typeof node !== "object" || seen.has(node)) break;
    seen.add(node);

    const code = (node as { code?: unknown }).code;
    if (typeof code === "string") {
      if (FK_PRISMA_CODES.includes(code) || FK_SQLSTATE_CODES.includes(code)) {
        return true;
      }
    }
    node = (node as { cause?: unknown }).cause;
  }

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return EMBEDDED_SQLSTATE.test(message) || FK_VIOLATION_TEXT.test(message);
}
