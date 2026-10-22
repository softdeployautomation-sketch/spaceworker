import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { assertAdminDeviceAccess } from "@/lib/admin-devices";
import { removeDevice } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// TASK_231 — POST /api/admin/devices/[deviceId]/remove
//
//   The admin's "Move to Deleted": the SAME soft-delete the owner's Delete
//   writes (`removeDevice` — uninstall first, then `removedAt`), run on the
//   target user's row with `approvalChannel: "admin"` so the owner's Activity
//   tab shows an admin action, not an owner action.
//
//   body { localOnly?: boolean } — when the agent can't be reached the UI
//   asks once and retries with `localOnly: true`: hide the row WITHOUT
//   touching the agent. Truthful and admin-only (the customer console no
//   longer surfaces this escape hatch — see components/device-list.tsx).
//
// Guard: `assertAdminDeviceAccess` first — an unknown id AND a soft-deleted
// row are both `device_not_found` (404), the deep-404 rule every admin device
// action uses (a deleted device "does not exist" until recovered).
//
// Statuses: 403 no admin session · 404 unknown/removed row ·
// 503 `agent_offline` (removal did not happen, row untouched — retry with
// localOnly or later) · 502 anything else from the Vantra layer.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let body: { localOnly?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const localOnly = body.localOnly === true;

  let device: Awaited<ReturnType<typeof assertAdminDeviceAccess>>;
  try {
    device = await assertAdminDeviceAccess(deviceId);
  } catch (err) {
    const code = err instanceof Error ? err.message : "device_not_found";
    if (code === "device_not_found") {
      return NextResponse.json({ error: "Device not found." }, { status: 404 });
    }
    return NextResponse.json({ error: code }, { status: 500 });
  }

  try {
    const result = await removeDevice({
      userId: device.owner.id,
      deviceId,
      localOnly,
      approvalChannel: "admin",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const code = err instanceof Error ? err.message : "remove_failed";
    if (code === "device_not_found") {
      return NextResponse.json({ error: "Device not found." }, { status: 404 });
    }
    if (code === "agent_offline") {
      return NextResponse.json(
        // `code` is machine-readable for the UI's honest "move anyway" retry;
        // `error` is the human line it shows if that retry never comes.
        { error: "The agent can't be reached right now — nothing was removed.", code },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: code }, { status: 502 });
  }
}
