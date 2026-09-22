import { NextResponse } from "next/server";

import { resolveInstallToken } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — one-time install-link resolver. GET /link/vantra/<token> →
// 302 to the real (Vantra/agent-host) installer download URL, or a 410 page
// if the token is unknown/expired/used-up-by-expiry. The token is single-
// purpose and time-boxed; the raw TRMM deployment URL is never exposed
// anywhere but this redirect.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/.test(token)) {
    return NextResponse.json({ error: "invalid_link" }, { status: 410 });
  }
  try {
    const downloadUrl = await resolveInstallToken(token);
    if (!downloadUrl) {
      return NextResponse.json({ error: "expired_or_unknown_link" }, { status: 410 });
    }
    return NextResponse.redirect(downloadUrl, 302);
  } catch {
    return NextResponse.json({ error: "link_resolution_failed" }, { status: 502 });
  }
}