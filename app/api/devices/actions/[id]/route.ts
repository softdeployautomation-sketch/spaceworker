import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { approveDeviceAction } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — approve (execute once) / reject a device-action proposal.
//   id = the AgentPendingAction id. One-time: a second approve 409s.
//   POST { }                → approve + execute now
//   POST { decision }       → unsupported verb guard
//   DELETE                  → reject

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  try {
    const result = await approveDeviceAction({
      userId: session.userId,
      pendingActionId: id,
      approvalChannel: "web",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const code = err instanceof Error ? err.message : "approve_failed";
    const status =
      code === "not_pending" ? 409
      : code === "bad_payload" ? 400
      : code === "vantra_not_configured" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const rows = await db.agentPendingAction.updateMany({
    where: { id, userId: session.userId, kind: "device", status: "pending", expiresAt: { gt: new Date() } },
    data: { status: "rejected" },
  });
  if (rows.count === 0) {
    return NextResponse.json({ error: "not_pending" }, { status: 409 });
  }
  await db.deviceAction.updateMany({
    where: { pendingActionId: id, status: "requested" },
    data: { status: "rejected" },
  });
  return NextResponse.json({ ok: true, decision: "rejected" });
}