import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import {
  deviceListSelector,
  DEVICE_ONLINE_WINDOW_MS,
  toDeviceView,
} from "@/lib/devices";
import { fetchUserIdle } from "@/lib/vantra-link";

// Task 92/95 — the user's device list. Read-only: everything mutating is a
// gated proposal by design. ONE source of truth for the status the UI shows
// (the old page also rendered the Vantra-sync view, so a machine appeared
// twice with two different statuses).
//
// Task 106 (bit C1) — adds best-effort `idleSeconds` per row (MeshCentral
// `idletime`, normalised to seconds by Vantra). Vantra unreachable or no
// linked org → still 200 with `idleSeconds: null`.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // TASK_118 B8-1: the "hosted" row is our own clone-destination browser
  // (lib/clone-destination.ts), infrastructure the account doesn't own or
  // manage — never a PC the user thinks they have to look after. Excluded
  // here, not just cosmetically renamed, so it can never appear in the
  // device list, get clicked into a console, or be targeted by a device
  // action meant for a real machine.
  const devices = await prisma.device.findMany({
    where: { userId: session.userId, deviceKind: { not: "hosted" } },
    orderBy: { createdAt: "asc" },
    select: deviceListSelector,
  });

  let idleByHostname: Record<string, number | null> = {};
  try {
    idleByHostname = await fetchUserIdle(session.userId);
  } catch {
    idleByHostname = {};
  }

  return NextResponse.json({
    onlineWindowMs: DEVICE_ONLINE_WINDOW_MS,
    devices: devices.map((d) => {
      const view = toDeviceView(d);
      return { ...view, idleSeconds: idleByHostname[view.name] ?? null };
    }),
  });
}