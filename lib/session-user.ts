import "server-only";
import { cookies } from "next/headers";
import { verifySession } from "./auth";
import { db } from "./db";

export async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("sw_session")?.value || null;
}

export async function getCurrentUser() {
  const token = await getSessionToken();
  if (!token) return null;

  const session = await verifySession(token);
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { id: session.userId },
  });

  return user;
}
