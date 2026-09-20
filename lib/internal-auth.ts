import "server-only";

// Task 53 — shared fail-closed gate for every /api/internal/* route.
//
// Before this, each internal route did `auth !== \`Bearer ${process.env.INTERNAL_BEARER_TOKEN}\``
// directly. That comparison FAILS OPEN if the env var is ever unset/blank: the
// template literal degrades to the literal string "Bearer undefined", and any
// request carrying `Authorization: Bearer undefined` sailed through — a trivial,
// guessable bypass. That was the opposite of the fail-closed discipline
// lib/admin-auth.ts demonstrates (unset secret = "locked", never "open").
//
// Mirrors requireAdminSession()'s boolean shape: returns true only when a
// non-empty bearer token is configured AND the request matches it.
export function requireInternalBearer(req: Request): boolean {
  const token = process.env.INTERNAL_BEARER_TOKEN;
  if (!token || token.trim().length === 0) return false; // unset/blank => LOCKED
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${token}`;
}