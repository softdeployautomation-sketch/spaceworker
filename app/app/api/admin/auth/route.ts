import { NextResponse } from "next/server";
import { checkAdminPasscode, createAdminSession, ADMIN_COOKIE } from "@/lib/admin-auth";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  if (!process.env.ADMIN_PASSCODE) {
    return NextResponse.json(
      { error: "Admin panel is not configured" },
      { status: 503 }
    );
  }

  let body: { passcode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!checkAdminPasscode(body.passcode ?? "")) {
    return NextResponse.json({ error: "Invalid passcode" }, { status: 401 });
  }

  const token = await createAdminSession();
  const cookieStore = await cookies(); // MUST await — async in Next.js 16
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 4,
    path: "/",
  });

  return NextResponse.json({ ok: true });
}