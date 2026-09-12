import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { buildSmtpTransport } from "@/lib/mailer-send";

// Task 26, Piece 5a — PRE-SAVE mailbox connection test.
// POST /api/mailboxes/test-connection   body: { host, port, username, password, allowInsecure }
//
// This is intentionally a raw, stateless check on the FORM's current values —
// exactly what the user is about to save, before any row exists / password is
// encrypted. It builds a transport through the SAME buildSmtpTransport helper a
// real send uses (so the security modes behave identically), calls
// transporter.verify(), and returns { ok: true } or { ok: false, error }.
// Nothing is persisted, no mailbox row is touched. It does not send mail, so it
// is safe to offer in both create and edit modes. The plaintext password never
// leaves the request body or crosses into any durable state.

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    host?: unknown;
    port?: unknown;
    username?: unknown;
    password?: unknown;
    allowInsecure?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const port = Number(body.port ?? 0);
  const allowInsecure = Boolean(body.allowInsecure);

  if (!host || !username || !password || !Number.isInteger(port) || port <= 0) {
    return NextResponse.json(
      { error: "host, port, username and password are required" },
      { status: 400 }
    );
  }

  try {
    const transport = buildSmtpTransport({ host, port, username, password, allowInsecure });
    await transport.verify();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" });
  }
}