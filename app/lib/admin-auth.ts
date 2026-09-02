import "server-only";
import { timingSafeEqual } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "sw_admin";
const secret = new TextEncoder().encode(process.env.JWT_SECRET!);

export async function createAdminSession(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spaceworker")
    .setAudience("spaceworker_admin")
    .setExpirationTime("4h")
    .sign(secret);
}

export async function verifyAdminSession(token: string): Promise<boolean> {
  if (!process.env.ADMIN_PASSCODE) return false;
  try {
    await jwtVerify(token, secret, { issuer: "spaceworker", audience: "spaceworker_admin" });
    return true;
  } catch {
    return false;
  }
}

export function checkAdminPasscode(input: string): boolean {
  const stored = process.env.ADMIN_PASSCODE;
  if (!stored) return false;
  try {
    return timingSafeEqual(Buffer.from(input), Buffer.from(stored));
  } catch {
    return false;
  }
}

export async function getAdminSession(): Promise<boolean> {
  const cookieStore = await cookies(); // MUST await — async in Next.js 16
  const token = cookieStore.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  return verifyAdminSession(token);
}