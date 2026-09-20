import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";
import { MAILBOX_SAFE_SELECT } from "@/lib/mailbox-safe-select";
import { validatePublicSmtpHost } from "@/lib/smtp-host-guard";

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
    fromAddresses?: unknown; password?: string; secure?: boolean; dailyLimit?: number; allowInsecure?: boolean;
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
  // Task 30, item 4 — multiple From addresses per mailbox (rotated across
  // recipients at queue-build time). Empty list = send as the SMTP username.
  const fromAddresses = Array.isArray(body.fromAddresses)
    ? body.fromAddresses.map((a) => String(a ?? "").trim()).filter((a) => a.length > 0)
    : [];
  const password = body.password ?? "";
  const dailyLimit = Number(body.dailyLimit ?? 40);
  // Task 26, Piece 5a — `secure` (implicit TLS) is DERIVED from port, never taken
  // from a checkbox: 465 => implicit TLS, anything else => STARTTLS (enforced
  // server-side). allowInsecure is the only explicit plaintext opt-out, for the
  // "None" mode, and is stored as its own column.
  const secure = port === 465;
  const allowInsecure = body.allowInsecure !== undefined ? Boolean(body.allowInsecure) : false;

  if (!label || !host || !username || !password || !Number.isInteger(port) || port <= 0) {
    return NextResponse.json(
      { error: "label, host, port, username and password are required" },
      { status: 400 }
    );
  }

  // Task 51 — reject loopback/private/link-local/non-routable hosts at SAVE time
  // so a mailbox whose host points at an internal address can never be stored
  // (that also protects the real send path, which only ever reads saved hosts).
  try {
    await validatePublicSmtpHost(host);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid SMTP host" },
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
      // Empty list -> send as the SMTP username; never store "" elements.
      fromAddresses,
      encryptedPassword: ciphertext,
      passwordIv: iv,
      passwordTag: tag,
      secure,
      allowInsecure,
      dailyLimit,
    },
    select: MAILBOX_SAFE_SELECT,
  });

  return NextResponse.json(mailbox);
}