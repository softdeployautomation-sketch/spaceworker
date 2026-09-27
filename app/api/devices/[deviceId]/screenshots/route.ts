import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";
import {
  deleteDeviceFrameTree,
  listRecentFrames,
  resolveScreenshotSettings,
} from "@/lib/device-screenshots";

export const dynamic = "force-dynamic";

// TASK_127 Phase 1 — device-side screen monitoring API (the console's panel).
//   GET   → THIS device's opt-in state, the global policy it is subject to, and
//           its recent frames (metadata only — the image bytes are served by
//           ./[frameId]).
//   PATCH → toggle the per-device opt-in ({ enabled: boolean }).
//   DELETE→ delete every stored frame for this device on demand.
//
// Owner-scope rule (same as the clone routes): the device is resolved by id AND
// session.userId, so another user's device is 404, never 403 — and never a
// 200 with someone else's screen on it.
//
// The per-device switch is the consent boundary the task doc makes
// non-negotiable: the global admin switch alone never captures anything.

/** Resolve a device the caller owns, or null. */
async function ownedDevice(deviceId: string, userId: string) {
  return db.device.findFirst({
    where: { id: deviceId, userId },
    select: { id: true, name: true, status: true, screenshotMonitoringEnabled: true },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  const device = await ownedDevice(deviceId, session.userId);
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const policy = resolveScreenshotSettings(await getAdminSettings());
  const frames = await listRecentFrames(device.id, 20);

  return NextResponse.json({
    device: {
      id: device.id,
      name: device.name,
      status: device.status,
      optIn: device.screenshotMonitoringEnabled,
    },
    // The owner can see the policy they are subject to, but only an admin can
    // change it — this is read-only here on purpose.
    policy: {
      enabled: policy.enabled,
      intervalMinutes: policy.intervalMinutes,
      retentionDays: policy.retentionDays,
    },
    frames,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  const device = await ownedDevice(deviceId, session.userId);
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  await db.device.update({
    where: { id: device.id },
    data: { screenshotMonitoringEnabled: body.enabled },
  });

  // Turning the opt-in OFF must stop work that is already waiting: a queued
  // governor entry for this device would otherwise be granted on the next tick
  // and capture a device whose owner has just switched monitoring off.
  if (!body.enabled) {
    await db.governorQueueEntry.updateMany({
      where: { feature: "deviceScreenshots", ref: device.id, status: "queued" },
      data: { status: "cancelled", reason: "opt_in_disabled" },
    });
  }

  return NextResponse.json({ ok: true, optIn: body.enabled });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  const device = await ownedDevice(deviceId, session.userId);
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Files first, then the rows — the same order the retention purge uses (see
  // purgeExpiredFrames). A row left without its file is harmless; a file left
  // with no row would be an unreferenced picture of someone's screen.
  await deleteDeviceFrameTree(device.id);
  const removed = await db.deviceScreenshot.deleteMany({ where: { deviceId: device.id } });

  return NextResponse.json({ ok: true, removed: removed.count });
}
