import "server-only";

import bcrypt from "bcrypt";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

import { env } from "./env";

// Session cookie name + params. httpOnly + Secure + SameSite=Lax.
// Deliberately distinct from Vantra's ("vantra_session"/"vantra") so a session
// token from one product can never be mistaken for the other's, even in theory.
export const SESSION_COOKIE = "spaceworker_session";
const SESSION_ISSUER = "spaceworker";
const SESSION_AUDIENCE = "spaceworker";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

const encoder = new TextEncoder();
const secretKey = () => encoder.encode(env.sessionSecret);

// Task 45 — a session can be "full" (everything that exists today, unchanged)
// or "license_only" (can see and manage their EXE licenses, nothing else — the
// narrow session issued by the license-claim flow so an EXE-only buyer never
// gets the whole paid web product for free). `scope` is OPTIONAL in the input
// payload so every existing call site (login, signup, verify) keeps working
// unchanged — an omitted scope defaults to "full". It lives in the JWT itself,
// so middleware can resolve it cheaply (cookie read + one HMAC, no DB round
// trip) for the 99% of users who are "full".
export type SessionScope = "full" | "license_only";

export interface SessionPayload {
  sub: string; // user id
  email: string;
  emailVerified: boolean;
  scope?: SessionScope; // omitted => "full" (today's behaviour, unchanged)
}

function normalizeScope(raw: unknown): SessionScope {
  return raw === "license_only" ? "license_only" : "full";
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({
    email: payload.email,
    emailVerified: payload.emailVerified,
    scope: normalizeScope(payload.scope),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .sign(secretKey());
}

/** Decodes + validates a JWT. Returns null if invalid/expired. */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ""),
      emailVerified: Boolean(payload.emailVerified),
      // Task 45 — an older token issued before `scope` existed has no scope
      // claim, which must read as "full" so a pre-existing session keeps working
      // exactly as it did before this change.
      scope: normalizeScope(payload.scope),
    };
  } catch {
    return null;
  }
}

/** Sets the session cookie on the current request/response context. */
export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const token = await createSessionToken(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

/** Clears the session cookie. */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Reads and validates the current session from cookies. Returns null if none. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}