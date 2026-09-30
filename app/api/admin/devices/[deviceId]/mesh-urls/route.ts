import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { adminCommandErrorStatus, splitDeviceError } from "@/lib/admin-devices";
import { adminFetchMeshUrls } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_147 — GET /api/admin/devices/[deviceId]/mesh-urls
//
// The remote-control viewer's URL for ONE device, as the admin. SILENT: the
// owner is not asked and not told, and nothing customer-facing is written (the
// open is logged to AdminDeviceCommand only — see adminFetchMeshUrls).
//
// This is the counterpart to the customer route
// (app/api/devices/[deviceId]/mesh-urls/route.ts), which requires an ownership
// match plus a `pendingActionId` approval grant. Neither gate applies here: the
// admin session IS the authorization, and the device is addressed by OUR id so
// a forged id can never be rerouted to another owner's machine (Vantra asserts
// the agent belongs to the `sw-<userId>` org read off our own row).
//
// The response is the same `{ok, urls}` envelope the console already consumes,
// so the UI can reuse the proven iframe pattern (components/device-console.tsx).
export async function GET(_req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  try {
    const result = await adminFetchMeshUrls({ deviceId });
    return NextResponse.json({
      ok: true,
      deviceId: result.deviceId,
      deviceName: result.deviceName,
      ownerEmail: result.ownerEmail,
      urls: result.urls,
    });
  } catch (err) {
    const { code, message } = splitDeviceError(err);
    return NextResponse.json(
      { error: message, code },
      { status: adminCommandErrorStatus(code) },
    );
  }
}
