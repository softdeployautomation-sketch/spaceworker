import { NextResponse } from "next/server";
import { requireInternalBearer } from "@/lib/internal-auth";
import { recordHeartbeat } from "@/lib/devices";

// Task 92 — device telemetry ingest. Internal-bearer gated (the Vantra-agent
// identity path arrives with Task 93's provisioning; until then this is the
// ingestion seam the VM/agent harness calls). Strictly whitelisted fields
// only — this must never become a "collect arbitrary data" sink (plan
// CROSS-TRACK RULE 2). Respects the owner's master telemetry toggle.

export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const vantraAgentId = typeof body.vantraAgentId === "string" ? body.vantraAgentId.trim() : "";
  if (!userId || !vantraAgentId) {
    return NextResponse.json({ error: "userId and vantraAgentId are required" }, { status: 400 });
  }

  try {
    const result = await recordHeartbeat(userId, {
      vantraAgentId,
      name: typeof body.name === "string" ? body.name : undefined,
      osName: typeof body.osName === "string" ? body.osName : undefined,
      osVersion: typeof body.osVersion === "string" ? body.osVersion : undefined,
      agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : undefined,
      ipAddress: typeof body.ipAddress === "string" ? body.ipAddress : undefined,
      hardwareSummary: body.hardwareSummary,
      telemetry: body.telemetry,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "heartbeat_failed";
    if (msg === "telemetry_disabled") {
      return NextResponse.json({ error: "Device telemetry is disabled for this account" }, { status: 409 });
    }
    if (msg === "owner_not_found") {
      return NextResponse.json({ error: "Unknown user" }, { status: 404 });
    }
    console.error("[devices/heartbeat] failed:", err);
    return NextResponse.json({ error: "heartbeat_failed" }, { status: 500 });
  }
}