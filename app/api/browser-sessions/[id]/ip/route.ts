import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { specForSession } from "@/lib/browser-session-proxy";
import { checkIpThroughProxy } from "@/lib/browser-proxy";

// GET /api/browser-sessions/[id]/ip — a live, real "what's my IP" check performed
// THROUGH the session's own routing surface (same proxy/exit node the session's
// Chrome uses), so a broken route is visibly caught rather than silently trusted.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const row = await prisma.browserSession.findFirst({
    where: { id, userId: session.userId },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status !== "running") {
    return NextResponse.json({ error: "Session is not running" }, { status: 400 });
  }

  let spec;
  try {
    spec = specForSession(row);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No route to check" },
      { status: 400 }
    );
  }

  try {
    const ip = await checkIpThroughProxy(spec);
    const location =
      row.proxyMode === "free" && row.exitNodeId
        ? row.exitNodeId.toUpperCase()
        : "BYO proxy";
    return NextResponse.json({ ok: true, ip, proxyMode: row.proxyMode, location });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "IP check failed" },
      { status: 502 }
    );
  }
}