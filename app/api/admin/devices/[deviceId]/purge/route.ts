import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { purgeAdminDevice } from "@/lib/admin-devices";
import { recordAgentActionAudit } from "@/lib/devices";

export const dynamic = "force-dynamic";

// TASK_231 — DELETE /api/admin/devices/[deviceId]/purge
//
//   The Deleted subtab's "Delete permanently": drops the row AND every child
//   record (plus the screenshot frame tree) for good. It ONLY accepts a row
//   that is already soft-deleted — `device_not_deleted` (409) otherwise, so a
//   live device always has to pass through "Move to Deleted" first.
//
// The lib refuses `agent_still_active` / `agent_unverified` BEFORE touching
// anything: a row whose agent Vantra still lists would be recreated by the
// next sync's upsert (see purgeAdminDevice / ensureSwAgentRemoved).
//
// Admin session asserts ITSELF here, like every other app/api/admin/** route
// (the page layout does not cover the API tree). 403 without.
//
// Audit: the house pattern for an admin mutation on a customer row —
// `recordAgentActionAudit(..., approvalChannel: "admin")`. It lands on the
// owner's Activity tab: the device is about to vanish from their console and
// the record of why must survive the purge (AgentActionAudit has no FK to
// Device).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  try {
    const device = await purgeAdminDevice({ deviceId });

    await recordAgentActionAudit({
      userId: device.owner.id,
      action: "device_purged",
      status: "executed",
      initiatingChannel: "api",
      approvalChannel: "admin",
      sourceDeviceId: device.id,
      detail: { name: device.name, agentRemoved: device.agentRemoved },
    });

    return NextResponse.json({ ok: true, device });
  } catch (err) {
    const code = err instanceof Error ? err.message : "purge_failed";
    if (code === "device_not_found") {
      return NextResponse.json({ error: "Device not found." }, { status: 404 });
    }
    if (code === "device_not_deleted") {
      return NextResponse.json(
        { error: "This device is not deleted yet — move it to Deleted first." },
        { status: 409 },
      );
    }
    if (code === "agent_still_active") {
      return NextResponse.json(
        { error: "The agent is still registered with the backend — nothing was deleted. Try again." },
        { status: 409 },
      );
    }
    if (code === "agent_unverified") {
      return NextResponse.json(
        { error: "Couldn't verify the agent is gone — nothing was deleted. Try again in a moment." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: code }, { status: 500 });
  }
}
