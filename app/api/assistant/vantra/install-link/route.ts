import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { mintInstallLink } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — mint a fresh one-time install link (72h TTL). The user sees the
// wrapper URL once; the real TRMM deployment URL is resolved server-side on
// click and never stored client-side.

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const link = await mintInstallLink(session.userId);
    return NextResponse.json({ ok: true, link });
  } catch (err) {
    const code = err instanceof Error ? err.message : "mint_failed";
    const status = code === "no_link" ? 404 : code === "vantra_not_configured" ? 503 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}