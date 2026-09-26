import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireInternalBearer } from "@/lib/internal-auth";
import { isDeviceOnline } from "@/lib/devices";
import { notifyUser } from "@/lib/notify";

// 2026-09-26 — ported from Vantra's proven pattern
// (app/api/internal/telegram-device-check/route.ts there): compare each
// device's current online/offline state against what the LAST sweep saw
// (Device.lastNotifiedOnline), and only notify on a genuine transition — a
// device that stays offline across many sweeps must never re-notify every
// cycle. `lastNotifiedOnline === null` means "never swept before" and
// deliberately skips notifying (a brand-new device's first sweep would
// otherwise fire a spurious "back online").
//
// POST /api/internal/device-status-sweep, gated by INTERNAL_BEARER_TOKEN,
// hit by deploy/device-status-sweep.timer every 5 minutes (same cadence as
// Vantra's poller; DEVICE_ONLINE_WINDOW_MS is 10 min, so 5-min sweeps catch a
// transition within one missed heartbeat window).
export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only devices whose owner has the master telemetry toggle on AND wants at
  // least one direction of alert — everyone else is skipped before any work.
  const devices = await prisma.device.findMany({
    where: {
      user: {
        deviceTelemetryEnabled: true,
        OR: [{ notifyDeviceOffline: true }, { notifyDeviceOnline: true }],
      },
    },
    select: {
      id: true,
      name: true,
      userId: true,
      lastSeenAt: true,
      lastNotifiedOnline: true,
      user: { select: { notifyDeviceOffline: true, notifyDeviceOnline: true } },
    },
  });

  let notified = 0;
  let checked = 0;

  for (const device of devices) {
    checked++;
    const isOnline = isDeviceOnline(device.lastSeenAt);
    const prev = device.lastNotifiedOnline;
    const shouldNotify = isOnline ? device.user.notifyDeviceOnline : device.user.notifyDeviceOffline;

    if (prev !== null && prev !== isOnline && shouldNotify) {
      try {
        await notifyUser(device.userId, {
          eventType: isOnline ? "device_online" : "device_offline",
          subject: isOnline ? `${device.name} is back online` : `${device.name} went offline`,
          emailHtml: isOnline
            ? `<p><strong>${device.name}</strong> is back online.</p>`
            : `<p><strong>${device.name}</strong> went offline.</p>`,
          telegramText: isOnline ? `✅ ${device.name} is back online.` : `🔴 ${device.name} went offline.`,
          agentText: isOnline ? `${device.name} is back online.` : `${device.name} went offline.`,
        });
        notified++;
      } catch (err) {
        // One device's notification failure must never abort the sweep for
        // the rest — notifyUser already logs its own per-channel outcome.
        console.error(`[device-status-sweep] notify failed for device ${device.id}:`, err);
      }
    }

    if (prev !== isOnline) {
      await prisma.device.update({
        where: { id: device.id },
        data: { lastNotifiedOnline: isOnline },
      });
    }
  }

  console.log(`[device-status-sweep] checked ${checked}, notified ${notified}`);
  return NextResponse.json({ checked, notified });
}
