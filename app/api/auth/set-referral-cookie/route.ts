import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const REFERRAL_COOKIE = "sw_ref";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ref = searchParams.get("ref");
  const redirectTo = searchParams.get("redirect") || "/login";

  const cookieStore = await cookies();

  if (ref) {
    cookieStore.set(REFERRAL_COOKIE, ref, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  return NextResponse.redirect(new URL(redirectTo, request.url));
}