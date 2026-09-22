import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Task 95 — the console Activity tab: this device's gated-action history
// (DeviceAction rows: power, scripts, remote control, PIN, overlay…). Read-
// only; the audit trail itself lives in AgentActionAudit (admin panel).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  // Ownership gate: the device must belong to the caller.
  const device = await db.device.findFirst({
    where: { id: deviceId, userId: session.userId },
    select: { id: true },
  });
  if (!device) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const actions = await db.deviceAction.findMany({
    where: { deviceId, userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      actionType: true,
      status: true,
      error: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, actions });
}
