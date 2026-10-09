import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminSession } from "@/lib/admin-auth";
import {
  getAdminScreenMonitor,
  setAdminScreenMonitor,
} from "@/lib/admin-devices";
import { recordAgentActionAudit } from "@/lib/devices";
import { resolveScreenshotSettings } from "@/lib/device-screenshots";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// TASK_190 S2 — GET/PATCH /api/admin/devices/[deviceId]/screen-monitor
//
//   GET   → the ADMIN's per-device switches (monitoring, notify-admin), the
//           read-only global cadence/retention dials, and the newest
//           CAPTURED frame (a captured frame with no summary is NORMAL).
//   PATCH → body {enabled?, adminNotifyEnabled?} — flips ONLY those two
//           Device columns via setAdminScreenMonitor (the lib builds the
//           update from the passed keys alone, so the owner's trigger/
//           digest switches cannot be reached from here) and writes one
//           audit row per changed switch on the OWNER's user id.
//
// Session asserts ITSELF here (403 without) — same as every route under
// app/api/admin/**; the page layout does not cover the API tree. The device
// goes through `assertAdminDeviceAccess`: unknown OR soft-deleted ⇒ 404,
// never 403 (a 403 would confirm a real id; a deleted row must be
// recovered before anything can act on it — TASK_188 S4 contract).

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    adminNotifyEnabled: z.boolean().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.adminNotifyEnabled !== undefined, {
    message: "Nothing to update",
  });

/** Map a lib error to its HTTP answer (deep 404 / validation 400). */
function libError(err: unknown): NextResponse | null {
  const code = err instanceof Error ? err.message : "";
  if (code === "device_not_found") {
    return NextResponse.json({ error: "Device not found." }, { status: 404 });
  }
  if (code === "nothing_to_update") {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  return null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  try {
    const monitor = await getAdminScreenMonitor(deviceId);

    // The global cadence/retention dials are READ-ONLY context for the
    // panel — same upsert-into-singleton read the admin screenshots route
    // uses, resolved through the SAME helper the capture scheduler uses so
    // the two can never disagree about what "60 min" means.
    const settingsRow = await prisma.adminSetting.upsert({
      where: { id: "singleton" },
      update: {},
      create: {},
    });
    const settings = resolveScreenshotSettings(settingsRow);

    return NextResponse.json({
      device: monitor.device,
      enabled: monitor.enabled,
      adminNotifyEnabled: monitor.adminNotifyEnabled,
      tier: monitor.tier,
      intervalMinutesOverride: monitor.intervalMinutesOverride,
      wakeDelayMinutes: monitor.wakeDelayMinutes,
      captureIntervalMinutes: settings.intervalMinutes,
      retentionDays: settings.retentionDays,
      latestFrame: monitor.latestFrame,
    });
  } catch (err) {
    return libError(err) ?? NextResponse.json({ error: "screen_monitor_failed" }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  try {
    const updated = await setAdminScreenMonitor({ deviceId, ...parsed });

    // One audit row per CHANGED switch, on the owner's user id — the house
    // pattern for an admin mutation landing on a customer row (same rail as
    // the restore route). Detail carries the new value so the Activity tab
    // can say what actually happened without a second query.
    const audits: Array<Promise<void>> = [];
    if (parsed.enabled !== undefined) {
      audits.push(
        recordAgentActionAudit({
          userId: updated.owner.id,
          action: "screen_monitor_toggle",
          status: "executed",
          initiatingChannel: "api",
          approvalChannel: "admin",
          sourceDeviceId: updated.id,
          detail: { name: updated.name, enabled: parsed.enabled },
        }),
      );
    }
    if (parsed.adminNotifyEnabled !== undefined) {
      audits.push(
        recordAgentActionAudit({
          userId: updated.owner.id,
          action: "admin_notify_toggle",
          status: "executed",
          initiatingChannel: "api",
          approvalChannel: "admin",
          sourceDeviceId: updated.id,
          detail: { name: updated.name, adminNotifyEnabled: parsed.adminNotifyEnabled },
        }),
      );
    }
    await Promise.all(audits);

    return NextResponse.json({
      ok: true,
      enabled: updated.enabled,
      adminNotifyEnabled: updated.adminNotifyEnabled,
    });
  } catch (err) {
    return libError(err) ?? NextResponse.json({ error: "screen_monitor_failed" }, { status: 500 });
  }
}
