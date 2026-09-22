import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { deviceStatus, DEVICE_ONLINE_WINDOW_MS } from "@/lib/devices";

// Task 92 — the user's device list (placeholder surface; the full grid +
// detail arrive with Task 95). Read-only: everything mutating is a gated
// proposal by design, so a bare list endpoint is safe.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const devices = await prisma.device.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      deviceKind: true,
      vantraAgentId: true,
      status: true,
      osName: true,
      osVersion: true,
      lastSeenAt: true,
      createdAt: true,
      powerPolicy: { select: { mode: true, until: true } },
    },
  });

  return NextResponse.json({
    onlineWindowMs: DEVICE_ONLINE_WINDOW_MS,
    devices: devices.map((d) => ({
      ...d,
      effectiveStatus: deviceStatus(d),
    })),
  });
}