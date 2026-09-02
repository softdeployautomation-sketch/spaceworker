import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { checkVerify, getClientIp } from "@/lib/rate-limit";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

export async function POST(req: Request) {
  if (!(await checkVerify(getClientIp(req)))) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let body: { email?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const code = (body.code ?? "").trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const codeRecord = await prisma.verificationCode.findFirst({
    where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { id: "desc" },
  });
  if (!codeRecord) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const updated = await prisma.verificationCode.update({
    where: { id: codeRecord.id },
    data: { attempts: { increment: 1 } },
  });
  if (updated.attempts > 5) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 400 });
  }

  const matches = await bcrypt.compare(code, codeRecord.codeHash);
  if (!matches) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.verificationCode.update({
      where: { id: codeRecord.id },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    }),
  ]);

  const token = await createSession(user.id);
  const cookieStore = await cookies(); // MUST await — async in Next.js 16
  cookieStore.set("sw_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });

  return NextResponse.json({ ok: true });
}