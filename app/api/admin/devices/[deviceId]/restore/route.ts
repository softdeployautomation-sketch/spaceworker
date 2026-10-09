import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { restoreAdminDevice } from "@/lib/admin-devices";
import { recordAgentActionAudit } from "@/lib/devices";

export const dynamic = "force-dynamic";

// TASK_188 S4 — PATCH /api/admin/devices/[deviceId]/restore
//
//   body { userId? }  → recover the soft-deleted row; hand it to `userId` when
//                       given (validate-then-write: an unknown target user is
//                       rejected BEFORE anything is touched), otherwise keep
//                       the current owner ("recover to the person who had it").
//
// The clear is written EXPLICITLY (`removedAt: null`) — the Vantra sync never
// resurrects a removed row, so it can never be relied on to un-remove one
// either (TASK_185 P4 rule, see restoreAdminDevice).
//
// Admin session asserts ITSELF here, exactly like every other route under
// app/api/admin/** — the page layout does not cover the API tree. 403 without.
//
// Audit: the house pattern for an admin mutation that lands on a customer row
// is `recordAgentActionAudit(..., approvalChannel: "admin")` — same rail as
// `app/api/admin/users/[id]/entitlements/route.ts`. It lands on the target
// user's Activity tab, which is right: the device is about to reappear there.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {}; // empty/absent body ⇒ plain recover to the current owner
  }
  const userId =
    typeof body.userId === "string" && body.userId.trim().length > 0
      ? body.userId.trim()
      : undefined;

  try {
    const device = await restoreAdminDevice({ deviceId, userId });

    await recordAgentActionAudit({
      userId: device.owner.id,
      action: "device_restored",
      status: "executed",
      initiatingChannel: "api",
      approvalChannel: "admin",
      sourceDeviceId: device.id,
      detail: {
        name: device.name,
        reassignedTo: userId ?? null,
        ownerEmail: device.owner.email,
      },
    });

    return NextResponse.json({ ok: true, device });
  } catch (err) {
    const code = err instanceof Error ? err.message : "restore_failed";
    if (code === "device_not_found") {
      return NextResponse.json({ error: "Device not found." }, { status: 404 });
    }
    if (code === "user_not_found") {
      return NextResponse.json({ error: "Target user not found." }, { status: 404 });
    }
    return NextResponse.json({ error: code }, { status: 500 });
  }
}
