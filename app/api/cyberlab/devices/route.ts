import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156B C2b (PLAN §13.5) — the lab's device picker source: the caller's
// OWN devices, with EXACTLY the same filter as the devices tab (userId match,
// not `hosted`, not removed — see app/api/devices/route.ts) so the lab can
// never offer a machine the Devices tab itself would refuse to show.
//
// The address hint is the device's LATEST agent-reported heartbeat IP. It is
// a HINT, not ground truth: a home PC behind NAT reports its LAN address, and
// the platform's toolbelt runs from our servers — the user must expose the
// service under test (port-forward) or pick a reachable target. The console
// caption states this; nothing here claims reachability.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const devices = await db.device.findMany({
    where: { userId: user.id, deviceKind: { not: "hosted" }, removedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      osName: true,
      status: true,
      lastSeenAt: true,
      heartbeats: { orderBy: { createdAt: "desc" }, take: 1, select: { ipAddress: true } },
    },
  });

  return NextResponse.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      osName: d.osName,
      status: d.status,
      lastSeenAt: d.lastSeenAt,
      lastIp: d.heartbeats[0]?.ipAddress ?? null,
    })),
  });
}