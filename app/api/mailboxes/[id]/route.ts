import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import type { Prisma } from "@prisma/client";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const existing = await prisma.mailbox.findFirst({
    where: { id, userId: session.userId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: {
    label?: string; host?: string; port?: number; username?: string;
    fromAddress?: string | null; password?: string; secure?: boolean; dailyLimit?: number; active?: boolean; allowInsecure?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Prisma.MailboxUpdateInput = {};
  if (body.label !== undefined) data.label = String(body.label).trim();
  if (body.host !== undefined) data.host = String(body.host).trim();
  if (body.port !== undefined) data.port = Number(body.port);
  if (body.username !== undefined) data.username = String(body.username).trim();
  if (body.fromAddress !== undefined) {
    const fromAddress = String(body.fromAddress ?? "").trim();
    // Empty string -> null/unset: never store "".
    data.fromAddress = fromAddress.length > 0 ? fromAddress : null;
  }
  // Task 26, Piece 5a — `secure` is derived from the (possibly new) port, never a
  // checkbox: 465 => implicit TLS, anything else => STARTTLS. allowInsecure is the
  // explicit plaintext opt-out for the "None" mode and is stored independently. A
  // save that changes port/security always recomputes secure from the resolved port.
  if (body.port !== undefined || body.allowInsecure !== undefined) {
    const resolvedPort = body.port !== undefined ? Number(body.port) : existing.port;
    data.secure = resolvedPort === 465;
  }
  if (body.allowInsecure !== undefined) data.allowInsecure = Boolean(body.allowInsecure);
  if (body.dailyLimit !== undefined) data.dailyLimit = Number(body.dailyLimit);
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.password !== undefined && String(body.password).length > 0) {
    const { ciphertext, iv, tag } = encryptSecret(String(body.password));
    data.encryptedPassword = ciphertext;
    data.passwordIv = iv;
    data.passwordTag = tag;
  }

  const mailbox = await prisma.mailbox.update({
    where: { id },
    data,
    select: MAILBOX_SAFE_SELECT,
  });

  return NextResponse.json(mailbox);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const mailbox = await prisma.mailbox.findFirst({
    where: { id, userId: session.userId },
  });
  if (!mailbox) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.mailbox.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}