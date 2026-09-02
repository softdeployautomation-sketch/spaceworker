import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function POST() {
  const cookieStore = await cookies(); // MUST await — async in Next.js 16
  cookieStore.delete("sw_session");
  return NextResponse.json({ ok: true });
}