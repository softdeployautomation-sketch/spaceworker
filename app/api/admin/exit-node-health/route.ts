import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { getExitNodeHealth } from "@/lib/exit-node-health";

// TASK_239 — live, cached reachability for every configured free exit node.
// Admin-only: this dials the same SOCKS routes customers use, so it must never
// be an anonymous probe surface. Cached 30s inside the lib; no-store here.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const nodes = await getExitNodeHealth();
  return NextResponse.json({ nodes }, { headers: { "cache-control": "no-store" } });
}
