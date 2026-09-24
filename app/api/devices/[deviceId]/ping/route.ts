import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { pingDevice } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_103 MISSING-1 — agent connectivity check. One-click, manual
// own-device, no approval (approvals are for agent-initiated actions only).
// A ping is NOT a command to execute later: it never creates a queue row —
// an offline device fails immediately.
//   POST → { ok, latencyMs, agentReachable, lastSeenAt }
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    const result = await pingDevice({ userId: session.userId, deviceId });
    return NextResponse.json({
      ok: true,
      latencyMs: result.latencyMs,
      agentReachable: true,
      lastSeenAt: result.lastSeenAt,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "ping_failed";
    if (code === "device_not_linked") {
      return NextResponse.json({ error: code }, { status: 404 });
    }
    // Offline / unreachable: immediate failure, no queue row. The console
    // shows "Agent not reachable" beside the last check-in age.
    return NextResponse.json({ error: code, agentReachable: false }, { status: 502 });
  }
}
