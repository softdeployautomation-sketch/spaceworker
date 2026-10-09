import { NextResponse } from "next/server";

import { clearSessionCookie, getSession } from "@/lib/auth";
import { stampLogout } from "@/lib/user-presence";

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
  return NextResponse.json({ ok: true });
}