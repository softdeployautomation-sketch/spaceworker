import { NextResponse } from "next/server";

import { submitPinCallback } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// Task 95 — PUBLIC device-side callback for the PIN-unlock prompt. The agent
// (run as the logged-in user) POSTs the typed PIN here with the one-time token
// baked into the prompt. No session — the token IS the credential. Single-use,
// expiry-checked, same response for unknown/expired/wrong-state (no oracle).
// Never logged; never written to audit detail.

export async function POST(req: Request) {
  let body: { token?: unknown; pin?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!token || !pin) {
    return NextResponse.json({ error: "token and pin are required." }, { status: 400 });
  }

  const sourceIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    undefined;

  try {
    await submitPinCallback({ token, pin, sourceIp });
    // Neutral 200 regardless of token validity shape — handled inside.
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid or expired request." }, { status: 400 });
  }
}
