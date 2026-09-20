import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import { validatePublicSmtpHost } from "@/lib/smtp-host-guard";
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
    fromAddresses?: unknown; password?: string; secure?: boolean; dailyLimit?: number; active?: boolean; allowInsecure?: boolean;
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
  if (body.fromAddresses !== undefined) {
    // Task 30, item 4 — multiple From addresses (rotated at queue-build time).
    const fromAddresses = Array.isArray(body.fromAddresses)
      ? body.fromAddresses.map((a) => String(a ?? "").trim()).filter((a) => a.length > 0)
      : [];
    // Empty list -> send as the SMTP username; never store "" elements.
    data.fromAddresses = fromAddresses;
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

  // Task 51 — if the host is being changed, reject loopback/private/link-local /
  // non-routable addresses at save time (same gate as CREATE and test-connection).
  if (data.host !== undefined && typeof data.host === "string") {
    try {
      await validatePublicSmtpHost(data.host);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid SMTP host" },
        { status: 400 }
      );
    }
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