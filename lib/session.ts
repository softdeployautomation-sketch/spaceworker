import "server-only";
import { getSession as getAuthSession } from "./auth";

// Thin adapter over lib/auth.ts's getSession() — kept for the routes that
// expect a plain { userId } shape rather than the full SessionPayload.
export async function getSession(): Promise<{ userId: string } | null> {
  const session = await getAuthSession();
  if (!session) return null;
  return { userId: session.sub };
}