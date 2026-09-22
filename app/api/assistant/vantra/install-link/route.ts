import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { mintInstallLink } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 + 2026-10 console follow-up — mint install assets, per tier:
//   POST {}                       → public one-time link (default)
//   POST {kind:"private"}         → private PowerShell install command
// Private is entitlement-gated in mintInstallLink ("devices" entitlement —
// premium tier 5 covers it; free/trial users 403).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { kind?: unknown };
  const kind = body.kind === "private" ? "private" : "public";

  try {
    const link = await mintInstallLink(session.userId, kind);
    return NextResponse.json({ ok: true, link });
  } catch (err) {
    const code = err instanceof Error ? err.message : "mint_failed";
    const status =
      code === "no_link" ? 404
      : code === "private_not_granted" ? 403
      : code === "vantra_not_configured" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}