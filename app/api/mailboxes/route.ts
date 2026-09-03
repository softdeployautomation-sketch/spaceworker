import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mailboxes = await prisma.mailbox.findMany({
    where: { userId: session.userId },
    select: MAILBOX_SAFE_SELECT,
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(mailboxes);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    label?: string; host?: string; port?: number; username?: string;
    password?: string; secure?: boolean; dailyLimit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const label = (body.label ?? "").trim();
  const host = (body.host ?? "").trim();
  const port = Number(body.port ?? 587);
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  const secure = body.secure !== undefined ? Boolean(body.secure) : true;
  const dailyLimit = Number(body.dailyLimit ?? 40);

  if (!label || !host || !username || !password || !Number.isInteger(port) || port <= 0) {
    return NextResponse.json(
      { error: "label, host, port, username and password are required" },
      { status: 400 }
    );
  }

  const { ciphertext, iv, tag } = encryptSecret(password);
  const mailbox = await prisma.mailbox.create({
    data: {
      userId: session.userId,
      label,
      host,
      port,
      username,
      encryptedPassword: ciphertext,
      passwordIv: iv,
      passwordTag: tag,
      secure,
      dailyLimit,
    },
    select: MAILBOX_SAFE_SELECT,
  });

  return NextResponse.json(mailbox);
}