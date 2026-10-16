import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getReferralLinkByCode, recordReferralClick } from "@/lib/referral";

const REFERRAL_COOKIE = "sw_ref";
const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Public entry point for a referral link (shared by existing users).
 *
 * Validates the short code, records a click, stamps the `sw_ref` cookie so
 * /login and /signup recognize the visitor as referred, then sends them to
 * the sign-in page. Invalid codes bounce to the public homepage.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  const link = await getReferralLinkByCode(code);
  if (!link || !link.isActive) {
    return NextResponse.redirect(new URL("/?error=no_referral", process.env.APP_BASE_URL ?? "/"));
  }

  await recordReferralClick(code);

  const cookieStore = await cookies();
  cookieStore.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: REFERRAL_COOKIE_MAX_AGE,
  });

  return NextResponse.redirect(new URL("/login", process.env.APP_BASE_URL ?? "/"));
}
