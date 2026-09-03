import "server-only";
import { timingSafeEqual } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "sw_admin";
const secret = new TextEncoder().encode(process.env.SESSION_SECRET || "dev-secret-key-min-32-bytes-long");

export function adminConfigured(): boolean {
  return !!process.env.ADMIN_PASSCODE;
}

export async function createAdminSession(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spaceworker")
    .setAudience("spaceworker_admin")
    .setExpirationTime("4h")
    .sign(secret);
}

export async function setAdminSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 4, // 4 hours
    path: "/",
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE);
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

export function verifyAdminPasscode(input: string): boolean {
  const stored = process.env.ADMIN_PASSCODE;
  if (!stored) return false;
  try {
    return timingSafeEqual(Buffer.from(input), Buffer.from(stored));
  } catch {
    return false;
  }
}

export function checkAdminPasscode(input: string): boolean {
  return verifyAdminPasscode(input);
}

export async function getAdminSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  return verifyAdminSession(token);
}