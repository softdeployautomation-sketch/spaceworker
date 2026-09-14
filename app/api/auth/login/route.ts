import { NextResponse } from "next/server";
import { z } from "zod";

import { setSessionCookie, verifyPassword, type SessionScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(request: Request) {
  const ip = await getClientIp();

  const allowed = await allowAndRecord(ip, "login");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = loginSchema.parse(await request.json());
  } catch (e) {
    const msg =
      e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const email = parsed.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    // Generic message; don't reveal account existence.
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const valid = await verifyPassword(parsed.password, user.passwordHash);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  if (!user.emailVerified) {
    // Verified, correct password but email not verified yet — send to /verify.
    return NextResponse.json(
      {
        error: "Please verify your email before signing in.",
        needsVerification: true,
        email: user.email,
      },
      { status: 403 },
    );
  }

  // Task 45 — decide the session scope at sign-in time, from the user's CURRENT
  // state rather than a sticky flag. Normal accounts (signed up with a real
  // password, acceptedTermsAt set) are always "full" exactly as before. Only the
  // inline-created EXE buyer (acceptedTermsAt null — never went through signup,
  // only ever created server-side by findOrCreateUser with a random password) is
  // ever license_only, and only while they remain tier 0. Physically buying the
  // web subscription bumps tier to 1 (bumpWebTier), so the NEXT time they log in
  // normally with the real password they've since set, they're naturally upgraded
  // to "full" — no special-case code, no sticky flag that never changes.
  const scope: SessionScope =
    user.acceptedTermsAt === null && user.tier < 1 ? "license_only" : "full";

  await setSessionCookie({
    sub: user.id,
    email: user.email,
    emailVerified: true,
    scope,
  });
  return NextResponse.json({ ok: true });
}