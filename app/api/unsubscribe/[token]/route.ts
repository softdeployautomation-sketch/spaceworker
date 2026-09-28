import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe-token";

// Deliberately unauthenticated — this link is clicked from inside an email
// client, never from a logged-in SpaceWorker session. The token itself (HMAC
// over userId+email) is what authorizes the action, not a cookie.
//
// Two entry points, per RFC 8058 (List-Unsubscribe-Post / one-click):
//   GET  — a real person clicking the link in their mail client's UI.
//   POST — the mail CLIENT itself performing one-click unsubscribe on the
//          recipient's behalf (body is literally "List-Unsubscribe=One-Click";
//          this route doesn't need to parse it, any POST here IS the signal).
// Both do the exact same thing: upsert a Suppression row so no future
// campaign of this user's queues this address again.
async function unsubscribe(token: string): Promise<{ ok: boolean; email?: string }> {
  const decoded = verifyUnsubscribeToken(token);
  if (!decoded) return { ok: false };
  await prisma.suppression.upsert({
    where: { userId_email: { userId: decoded.userId, email: decoded.email } },
    create: { userId: decoded.userId, email: decoded.email, reason: "unsubscribed" },
    update: {},
  });
  return { ok: true, email: decoded.email };
}

function htmlPage(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe</title></head>` +
      `<body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1f2937">${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const result = await unsubscribe(token);
  if (!result.ok) {
    return htmlPage("<h1>Invalid or expired link</h1><p>This unsubscribe link couldn't be verified.</p>");
  }
  return htmlPage(`<h1>Unsubscribed</h1><p>${result.email} won't receive any further emails from this sender.</p>`);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const result = await unsubscribe(token);
  return NextResponse.json({ ok: result.ok }, { status: result.ok ? 200 : 400 });
}
