import "server-only";
import bcrypt from "bcrypt";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "sw_session";
const secret = new TextEncoder().encode(process.env.SESSION_SECRET || "dev-secret-key-min-32-bytes-long");

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("spaceworker")
    .setAudience("spaceworker_user")
    .setExpirationTime("7d")
    .sign(secret);
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function verifySession(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: "spaceworker",
      audience: "spaceworker_user",
    });
    return { userId: payload.userId as string };
  } catch {
    return null;
  }
}