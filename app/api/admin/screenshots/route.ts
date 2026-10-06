import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { countCapturing, resolveScreenshotSettings } from "@/lib/device-screenshots";

// TASK_127 Phase 1 — the owner-facing dials for device screen CAPTURE, plus the
// live read-out that says whether it is actually doing anything.
//
// WHY A SEPARATE ROUTE FROM /api/admin/governor: the governor route owns the six
// PRESSURE-model thresholds (RAM/swap/queue). These four are the feature's own
// policy — master switch, how many captures at once, how often per device, and
// how long frames are kept. The concurrency number is ALSO the governor's cap
// column, which is why it is described as such in the payload rather than being
// duplicated here.
//
// PATCH is a validated subset update, same discipline as the governor route:
// anything nonsensical (a cap of 0, a 0-day retention) is rejected at the edge
// instead of being quietly clamped later.

const WRITABLE = {
  enabled: { column: "screenshotMonitoringEnabled", kind: "bool" },
  // Floor of 1: "monitoring on but never capture" is never what is meant.
  maxConcurrent: { column: "screenshotCapturesMaxConcurrent", kind: "int", min: 1, max: 10 },
  intervalMinutes: { column: "screenshotCaptureIntervalMinutes", kind: "int", min: 1, max: 1440 },
  retentionDays: { column: "screenshotRetentionDays", kind: "int", min: 1, max: 365 },
  // TASK_168 Bug B — the SUMMARY budget dial: metered relay calls per device
  // per UTC day (× 3 images/call = frames/day). Floor of 1: 0 would mean
  // "summarise nothing, ever", which is the OFF switch's job. Cap of 48
  // (= 144 frames/day): beyond that the dial stops being a cost ceiling.
  summaryMaxCalls: { column: "screenshotSummaryMaxCallsPerDevicePerDay", kind: "int", min: 1, max: 48 },
} as const;

type WritableKey = keyof typeof WRITABLE;

async function buildView() {
  const row = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: {},
    create: {},
  });
  const settings = resolveScreenshotSettings(row);

  // Live read-out. Deliberately counts, never frame contents.
  const [capturing, captured, failed, optedInDevices, latest] = await Promise.all([
    countCapturing(),
    prisma.deviceScreenshot.count({ where: { status: "captured" } }),
    prisma.deviceScreenshot.count({ where: { status: "failed" } }),
    prisma.device.count({ where: { screenshotMonitoringEnabled: true } }),
    prisma.deviceScreenshot.findFirst({
      where: { status: "captured" },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, deviceId: true },
    }),
  ]);

  return {
    settings,
    live: {
      capturing,
      captured,
      failed,
      optedInDevices,
      lastCapturedAt: latest?.capturedAt ? latest.capturedAt.toISOString() : null,
      lastCapturedDeviceId: latest?.deviceId ?? null,
    },
  };
}

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(await buildView());
}

// PATCH — body: a SUBSET of { enabled?, maxConcurrent?, intervalMinutes?,
// retentionDays? }. Returns the whole view so the panel refreshes dials AND
// live counts in one round trip.
export async function PATCH(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: Record<string, boolean | number> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in WRITABLE)) {
      return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    }
    const spec = WRITABLE[key as WritableKey];
    if (spec.kind === "bool") {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
      data[spec.column] = value;
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < spec.min || n > spec.max) {
      return NextResponse.json(
        { error: `${key} must be a whole number between ${spec.min} and ${spec.max}` },
        { status: 400 },
      );
    }
    data[spec.column] = n;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Same upsert-into-singleton pattern the governor route uses, so the very
  // first PATCH (before any GET created the row) works.
  await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  return NextResponse.json(await buildView());
}
