import "server-only";

import { getSession } from "./auth";
import { db } from "./db";

/**
 * Loads the current user from the session cookie with a fresh, authoritative
 * DB read (rather than trusting the JWT payload alone). Returns null if there's
 * no valid session or the user row no longer exists.
 */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  const user = await db.user.findUnique({ where: { id: session.sub } });
  if (!user) return null;

  return user;
}