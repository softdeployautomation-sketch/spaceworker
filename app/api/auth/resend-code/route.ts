import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { sendEmail, verificationEmailHtml } from "@/lib/email";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { issueVerificationCode } from "@/lib/verify-code";

const resendSchema = z.object({
  email: z.string().email(),
});

export async function POST(request: Request) {
  const ip = await getClientIp();

  // Resend limited by IP: 1/60s AND 5/hr (both rules enforced).
  const allowed = await allowAndRecord(ip, "resend-code");
  if (!allowed) {
    return NextResponse.json(
      { error: "You're requesting codes too quickly. Please wait." },
      { status: 429 },
    );
  }

  let parsed;
  try {
    parsed = resendSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = parsed.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    // Don't reveal whether the account exists.
    return NextResponse.json({ message: "If that account exists, a code was sent." });
  }
  if (user.emailVerified) {
    return NextResponse.json({ message: "That account is already verified." });
  }

  const { code } = await issueVerificationCode(user.id);
  try {
    await sendEmail({
      to: email,
      subject: "Your SpaceWorker verification code",
      html: verificationEmailHtml(code),
    });
  } catch (err) {
    console.error("Failed to send verification email:", err);
    return NextResponse.json(
      { error: "We couldn't send the email right now. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ message: "A new code has been sent." });
}