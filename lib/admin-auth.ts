import "server-only";

import { timingSafeEqual } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

import { env } from "./env";

// Admin panel shared-passcode session — isolated from the customer session so
// the tokens are never interchangeable. Reuses the same SESSION_SECRET signing
// key and jose (already a dependency via lib/auth), but with a distinct
// issuer/audience and a shorter 12h lifetime given the elevated blast radius.
// Distinct from Vantra's admin session too ("spaceworker_admin_session" vs
// "vantra_admin_session").

export const ADMIN_SESSION_COOKIE = "spaceworker_admin_session";
const ADMIN_ISSUER = "spaceworker-admin";
const ADMIN_AUDIENCE = "spaceworker-admin";
const ADMIN_MAX_AGE = 60 * 60 * 12; // 12 hours

export interface AdminSessionPayload {
  sub: string; // "admin" — no per-admin accounts
}

const encoder = new TextEncoder();
const secretKey = () => encoder.encode(env.sessionSecret);

/** True when the admin panel login should be usable at all. */
export function adminConfigured(): boolean {
  return env.adminToken.trim().length > 0;
}

/**
 * Constant-time compare of the submitted passcode against ADMIN_TOKEN.
 * FAILS CLOSED when ADMIN_TOKEN is unset — the panel is never open.
 */
export function verifyAdminPasscode(passcode: string): boolean {
  const expected = env.adminToken;
  if (!expected || expected.trim().length === 0) return false;
  const a = Buffer.from(passcode, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createAdminSessionToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("admin")
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_MAX_AGE}s`)
    .setIssuer(ADMIN_ISSUER)
    .setAudience(ADMIN_AUDIENCE)
    .sign(secretKey());
}

export async function setAdminSessionCookie(): Promise<void> {
  const token = await createAdminSessionToken();
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_MAX_AGE,
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Reads + validates the admin session cookie. Returns null if none/invalid. */
export async function getAdminSession(): Promise<AdminSessionPayload | null> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ADMIN_ISSUER,
      audience: ADMIN_AUDIENCE,
    });
    if (payload.sub !== "admin") return null;
    return { sub: "admin" };
  } catch {
    return null;
  }
}

/**
 * Guard for admin API routes. Every app/api/admin/** route (except login) must
 * call this itself — the protected page layout does NOT cover the sibling API
 * route tree. Returns true when the request carries a valid admin session.
 */
export async function requireAdminSession(): Promise<boolean> {
  return (await getAdminSession()) !== null;
}