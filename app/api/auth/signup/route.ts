import { NextResponse } from "next/server";
import { z } from "zod";

import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendEmail, verificationEmailHtml } from "@/lib/email";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { issueVerificationCode } from "@/lib/verify-code";

const signupSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

export async function POST(request: Request) {
  const ip = await getClientIp();

  // Rate limit signup by IP: 5/hr.
  const allowed = await allowAndRecord(ip, "signup");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again later." },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = signupSchema.parse(await request.json());
  } catch (e) {
    const msg =
      e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const email = parsed.email.trim().toLowerCase();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    // Don't leak whether an account exists. Generic message.
    return NextResponse.json(
      { error: "We couldn't create an account with that email." },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(parsed.password);

  const user = await db.user.create({
    data: { email, passwordHash, emailVerified: false },
  });

  // Issue a 6-digit verification code (15-min expiry) and email it.
  // No client/site provisioning step exists here — that was Vantra-specific,
  // TRMM-related. Verification success just flips emailVerified.
  const { code } = await issueVerificationCode(user.id);
  try {
    await sendEmail({
      to: email,
      subject: "Your SpaceWorker verification code",
      html: verificationEmailHtml(code),
    });
  } catch {
    // Email delivery failure shouldn't destroy the account, but the user needs
    // a way to get a new code — they can request a resend from the verify page.
  }

  return NextResponse.json(
    { message: "Account created. Check your email for a verification code." },
    { status: 201 },
  );
}