import { NextResponse } from "next/server";

import { clearSessionCookie, getSession } from "@/lib/auth";
import { stampLogout } from "@/lib/user-presence";

// Invite-only / hidden-login (owner, 2026-10-16): on logout the user becomes a
// member of the public again — clear the referral cookie too, so `/home`
// bounces them to the clown page and they need their invite link to get back
// in. Same attributes as the stamp in login/page.tsx.
const REFERRAL_COOKIE = "sw_ref";

// TASK_183 / wrapper cookie fix: clearing `spaceworker_session` alone leaves
// `sw_wrapper` (=devices) alive in the browser, which keeps the dock narrowed
// to Devices + Settings even for tier-5 users after logout/login. Clear it on
// every logout so a wrapper-scoped cookie can never persist past sign-out.
const WRAPPER_MODE_COOKIE = "sw_wrapper";

export async function POST() {
  // TASK_190 S5 — signing out IS a presence transition (verify §4.4's
  // logout rows). Best-effort: a failed stamp must never block signing out,
  // so it runs BEFORE the cookie clear with its own catch.
  const session = await getSession();
  if (session?.sub) {
    try {
      await stampLogout(session.sub);
    } catch (err) {
      console.error("[presence] logout stamp failed:", err);
    }
  }
  await clearSessionCookie();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(REFERRAL_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  res.cookies.set(WRAPPER_MODE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}