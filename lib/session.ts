import "server-only";
import { cookies } from "next/headers";
import { verifySession } from "./auth";

export async function getSession(): Promise<{ userId: string } | null> {
  const cookieStore = await cookies(); // MUST await — async in Next.js 16
  const token = cookieStore.get("sw_session")?.value;
  if (!token) return null;
  return verifySession(token);
}