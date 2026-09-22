import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import {
  deviceListSelector,
  DEVICE_ONLINE_WINDOW_MS,
  toDeviceView,
} from "@/lib/devices";

// Task 92/95 — the user's device list. Read-only: everything mutating is a
// gated proposal by design. ONE source of truth for the status the UI shows
// (the old page also rendered the Vantra-sync view, so a machine appeared
// twice with two different statuses).

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const devices = await prisma.device.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "asc" },
    select: deviceListSelector,
  });

  return NextResponse.json({
    onlineWindowMs: DEVICE_ONLINE_WINDOW_MS,
    devices: devices.map(toDeviceView),
  });
}