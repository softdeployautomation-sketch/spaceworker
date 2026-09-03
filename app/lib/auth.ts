import "server-only";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "sw_session";
const secret = new TextEncoder().encode(process.env.JWT_SECRET!);

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