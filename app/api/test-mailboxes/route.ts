import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptSecret } from "@/lib/mailbox-crypto";

// Task 29, item 5 — let a user register their OWN deliverability test/seed
// mailbox (e.g. their own Gmail, which may filter differently than the platform's
// shared seed). Stored as a SeedMailbox row WITH a userId. A user with no own row
// keeps using the platform default; opting in is purely additive.
//
// The password is encrypted exactly the way sending-mailbox credentials are
// (lib/mailbox-crypto.ts), and it is used for IMAP reads only — never exposed.

const SAFE_SELECT = {
  id: true,
  label: true,
  host: true,
  port: true,
  username: true,
  secure: true,
  active: true,
  createdAt: true,
};

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const testMailboxes = await prisma.seedMailbox.findMany({
    where: { userId: session.userId },
    select: SAFE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(testMailboxes);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    label?: string; host?: string; port?: number; username?: string; password?: string; secure?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const label = (body.label ?? "").trim();
  const host = (body.host ?? "").trim();
  const port = Number(body.port ?? 993);
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  // IMAP: 993 is implicit TLS; other ports default to STARTTLS. Explicit override
  // allowed for odd providers.
  const secure = body.secure !== undefined ? Boolean(body.secure) : port === 993;

  if (!label || !host || !username || !password || !Number.isInteger(port) || port <= 0) {
    return NextResponse.json(
      { error: "label, host, port, username and password are required" },
      { status: 400 },
    );
  }

  // The username is globally unique on SeedMailbox — a row with the same address
  // belonging to ANOTHER user is off-limits.
  const byUsername = await prisma.seedMailbox.findUnique({ where: { username } });
  if (byUsername && byUsername.userId !== session.userId) {
    return NextResponse.json(
      { error: "That mailbox is already registered by another account." },
      { status: 409 },
    );
  }

  const { ciphertext, iv, tag } = encryptSecret(password);

  const saved = byUsername
    ? await prisma.seedMailbox.update({
        where: { id: byUsername.id },
        data: { label, host, port, secure, active: true, encryptedPassword: ciphertext, passwordIv: iv, passwordTag: tag },
        select: SAFE_SELECT,
      })
    : await prisma.seedMailbox.create({
        data: {
          userId: session.userId,
          label, host, port, username, secure, active: true,
          encryptedPassword: ciphertext, passwordIv: iv, passwordTag: tag,
        },
        select: SAFE_SELECT,
      });

  return NextResponse.json(saved);
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { id?: string };
  try { body = await req.json(); } catch { body = {}; }
  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const owned = await prisma.seedMailbox.findFirst({ where: { id, userId: session.userId } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.seedMailbox.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}