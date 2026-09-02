import { NextResponse } from "next/server";
import { z } from "zod";

import { setSessionCookie, verifyPassword } from "@/lib/auth";
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

  await setSessionCookie({
    sub: user.id,
    email: user.email,
    emailVerified: true,
  });
  return NextResponse.json({ ok: true });
}