import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import { captureDeviceNow, captureViaService } from "@/lib/device-screenshots";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// TASK_127 Phase 1 follow-up — manual "capture now" for the console's Screen
// monitoring card. Scheduled captures (deploy/screenshot-sweep.timer) only
// fire when a device is "due" per screenshotCaptureIntervalMinutes; this is
// the on-demand path an owner uses to verify monitoring works, or grab one
// fresh frame, without waiting for or holding a device online through a full
// interval window. Every other real gate still applies (master switch, this
// device's own opt-in, online check, "not already mid-capture," the same
// governor admission) — see lib/device-screenshots.ts's captureDeviceNow.
//
// Owner-scope rule (same as the sibling routes): the device is resolved by id
// AND session.userId, so another user's device is 404, never 403.

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { deviceId } = await params;

  const owned = await db.device.findFirst({
    where: { id: deviceId, userId: session.userId },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const result = await captureDeviceNow(deviceId, captureViaService);

  const status =
    result.status === "captured" ? 200
    : result.status === "queued" ? 202
    : result.status === "refused" && result.reason === "device_offline" ? 409
    : result.status === "refused" ? 400
    : 502; // "failed" — the capture ran but produced nothing

  return NextResponse.json(result, { status });
}
