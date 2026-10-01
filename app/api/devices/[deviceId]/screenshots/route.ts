import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";
import {
  deleteDeviceFrameTree,
  listRecentFrames,
  resolveEffectiveIntervalMinutes,
  resolveScreenshotSettings,
  SCREENSHOT_INTERVAL_MAX_MINUTES,
} from "@/lib/device-screenshots";

export const dynamic = "force-dynamic";

// TASK_127 Phase 1 — device-side screen monitoring API (the console's panel).
//   GET   → THIS device's opt-in state, its own interval override (if set),
//           the global policy it is subject to, and its recent frames
//           (metadata only — the image bytes are served by ./[frameId]).
//   PATCH → toggle the per-device opt-in ({ enabled: boolean }), and/or set
//           or clear this device's own schedule override
//           ({ intervalMinutesOverride: number | null }), and/or set or
//           clear its wake delay ({ wakeDelayMinutes: number | null }) —
//           "don't start capturing until N minutes after this device comes
//           back online."
//           TASK_152 M4: the override may only make THIS device LESS frequent
//           than the admin's global cadence (the global is a CEILING on
//           frequency) — a smaller/faster value is REJECTED here with 400,
//           never clamped. See lib/device-screenshots.ts
//           resolveEffectiveIntervalMinutes.
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
    select: {
      id: true,
      name: true,
      status: true,
      screenshotMonitoringEnabled: true,
      screenshotIntervalMinutesOverride: true,
      screenshotWakeDelayMinutes: true,
    },
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
  // TASK_152 M3 — 50, not 20: the Screen monitoring tab now renders a SCROLLABLE
  // timeline of frames with their summaries, so the owner can scan back over a
  // couple of days without clicking. The read model carries TEXT only (plus
  // metadata); the image bytes are still fetched per-frame from ./[frameId].
  const frames = await listRecentFrames(device.id, 50);

  const hasOverride = typeof device.screenshotIntervalMinutesOverride === "number";
  return NextResponse.json({
    device: {
      id: device.id,
      name: device.name,
      status: device.status,
      optIn: device.screenshotMonitoringEnabled,
      intervalMinutesOverride: device.screenshotIntervalMinutesOverride,
      wakeDelayMinutes: device.screenshotWakeDelayMinutes,
    },
    // The owner can see the policy they are subject to, but only an admin can
    // change the GLOBAL value — this device's own override (above) is theirs to
    // set. TASK_152 M4: the admin's global interval is a CEILING on frequency
    // (a floor on the interval), so effectiveIntervalMinutes = max(global,
    // override) — the exact same shared resolver listDueDevices uses.
    policy: {
      enabled: policy.enabled,
      intervalMinutes: policy.intervalMinutes,
      retentionDays: policy.retentionDays,
      effectiveIntervalMinutes: resolveEffectiveIntervalMinutes(
        policy.intervalMinutes,
        hasOverride ? device.screenshotIntervalMinutesOverride : null,
      ),
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

  // TASK_152 M4 — the admin's global cadence is the CEILING on capture
  // FREQUENCY for this device's override. Read it here so the bound is enforced
  // at the edge (reject, never clamp) rather than merely implied by the UI.
  const policy = resolveScreenshotSettings(await getAdminSettings());
  const fastestAllowed = policy.intervalMinutes;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const hasEnabled = "enabled" in body;
  const hasOverride = "intervalMinutesOverride" in body;
  const hasWakeDelay = "wakeDelayMinutes" in body;
  if (!hasEnabled && !hasOverride && !hasWakeDelay) {
    return NextResponse.json(
      { error: "enabled, intervalMinutesOverride and/or wakeDelayMinutes is required" },
      { status: 400 },
    );
  }
  if (hasEnabled && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  // null clears the override (back to the admin's global cadence); a whole
  // number sets it. TASK_152 M4 bounds: an override may only make THIS device
  // LESS frequent than the admin allows — 1..1440 overall, but never smaller
  // than the global ceiling. REJECTED (400), never clamped — same discipline as
  // app/api/admin/screenshots/route.ts's WRITABLE.
  let overrideValue: number | null | undefined;
  if (hasOverride) {
    const raw = body.intervalMinutesOverride;
    if (raw === null) {
      overrideValue = null;
    } else if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw >= fastestAllowed &&
      raw <= SCREENSHOT_INTERVAL_MAX_MINUTES
    ) {
      overrideValue = raw;
    } else {
      return NextResponse.json(
        {
          error:
            `intervalMinutesOverride must be null, or a whole number from ${fastestAllowed} ` +
            `(the service cadence) to ${SCREENSHOT_INTERVAL_MAX_MINUTES}. A machine cannot be ` +
            `captured more often than the service allows.`,
        },
        { status: 400 },
      );
    }
  }
  // null/0 clears the delay (capture starts as soon as online + due); a
  // positive number sets it. Same 1..1440 bound — a wait longer than a day
  // makes no practical sense here either.
  let wakeDelayValue: number | null | undefined;
  if (hasWakeDelay) {
    const raw = body.wakeDelayMinutes;
    if (raw === null || raw === 0) {
      wakeDelayValue = null;
    } else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1 && raw <= 1440) {
      wakeDelayValue = Math.floor(raw);
    } else {
      return NextResponse.json(
        { error: "wakeDelayMinutes must be null, 0, or a whole number between 1 and 1440" },
        { status: 400 },
      );
    }
  }

  const data: Record<string, unknown> = {};
  if (hasEnabled) data.screenshotMonitoringEnabled = body.enabled;
  if (hasOverride) data.screenshotIntervalMinutesOverride = overrideValue;
  if (hasWakeDelay) data.screenshotWakeDelayMinutes = wakeDelayValue;

  const updated = await db.device.update({
    where: { id: device.id },
    data,
    select: {
      screenshotMonitoringEnabled: true,
      screenshotIntervalMinutesOverride: true,
      screenshotWakeDelayMinutes: true,
    },
  });

  // Turning the opt-in OFF must stop work that is already waiting: a queued
  // governor entry for this device would otherwise be granted on the next tick
  // and capture a device whose owner has just switched monitoring off.
  if (hasEnabled && !body.enabled) {
    await db.governorQueueEntry.updateMany({
      where: { feature: "deviceScreenshots", ref: device.id, status: "queued" },
      data: { status: "cancelled", reason: "opt_in_disabled" },
    });
  }

  return NextResponse.json({
    ok: true,
    optIn: updated.screenshotMonitoringEnabled,
    intervalMinutesOverride: updated.screenshotIntervalMinutesOverride,
    wakeDelayMinutes: updated.screenshotWakeDelayMinutes,
  });
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
