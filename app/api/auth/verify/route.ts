import { NextResponse } from "next/server";
import { z } from "zod";

import { setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { consumeVerificationCode } from "@/lib/verify-code";

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export async function POST(request: Request) {
  const ip = await getClientIp();

  let parsed;
  try {
    parsed = verifySchema.parse(await request.json());
  } catch (e) {
    const msg =
      e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const email = parsed.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json(
      { error: "No account found for that email." },
      { status: 404 },
    );
  }

  if (user.emailVerified) {
    // CRITICAL FIX (2026-09-14): this used to call setSessionCookie() here and
    // return, granting a full authenticated session to ANYONE who knew this
    // user's email address — no password, no valid code, not even a check that
    // parsed.code was real (the zod schema only required 6 digits of ANY
    // value). That was a live account-takeover vulnerability present since the
    // very first commit of this project. An already-verified account has
    // nothing to "verify" here; send them to log in with their real password
    // instead of minting a session for a caller who has proven nothing.
    return NextResponse.json(
      { error: "This account is already verified. Please sign in instead.", alreadyVerified: true },
      { status: 409 },
    );
  }

  // Rate limit + cap brute-force attempts on the code.
  const allowed = await allowAndRecord(ip, "verify");
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 },
    );
  }

  const result = await consumeVerificationCode(user.id, parsed.code);

  switch (result.reason) {
    case "no_code":
      return NextResponse.json(
        { error: "No active verification code. Request a new one." },
        { status: 400 },
      );
    case "expired":
      return NextResponse.json(
        { error: "That code has expired. Request a new one." },
        { status: 410 },
      );
    case "attempts_exhausted":
      return NextResponse.json(
        { error: "Too many incorrect codes. Request a new one." },
        { status: 429 },
      );
    case "invalid":
      return NextResponse.json(
        { error: "That code is incorrect." },
        { status: 400 },
      );
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: "Verification failed." },
      { status: 400 },
    );
  }

  // Verified. No client/site provisioning — flip emailVerified and start a
  // session, after which the dashboard is reachable.
  await db.user.update({
    where: { id: user.id },
    data: { emailVerified: true },
  });

  await setSessionCookie({
    sub: user.id,
    email: user.email,
    emailVerified: true,
  });

  return NextResponse.json({ ok: true });
}