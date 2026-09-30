import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import {
  getAdminCommandBatch,
  parseAdminCommandBody,
  runAdminDeviceCommandBatch,
} from "@/lib/admin-devices";

export const dynamic = "force-dynamic";

// TASK_146 — POST /api/admin/devices/run-command  (BULK)
//
// One command, many devices. Every target is verified to exist server-side; the
// owner of each is read off the device row, so the client only ever sends ids it
// was shown — a fabricated id fails, it cannot be redirected at another owner's
// machine.
//
// Silently, same as the single route (AdminDeviceCommand only). Offline devices
// are NOT queued: the only existing queue the owner would see is
// DeviceQueuedCommand, which would break silence — they come back as an error
// for the admin to retry.
//
//   POST {deviceIds[], cmd, shell, timeout, runAsUser, concurrency?}
//     → { ok, batchId, total, okCount, failedCount, targets[] }
//   GET ?batchId=… → the recorded per-device rows for that batch
//
// Hard ceiling of 100 devices per call: a single admin click should never fan
// out to the whole fleet, and the fan-out is a synchronous PowerShell session per
// machine on the far side.
const MAX_BULK_DEVICES = 100;

export async function POST(req: Request) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: {
    deviceIds?: unknown;
    cmd?: unknown;
    shell?: unknown;
    timeout?: unknown;
    runAsUser?: unknown;
    concurrency?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const deviceIds = Array.isArray(body.deviceIds)
    ? body.deviceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  if (deviceIds.length === 0) {
    return NextResponse.json({ error: "deviceIds is required." }, { status: 400 });
  }
  if (deviceIds.length > MAX_BULK_DEVICES) {
    return NextResponse.json(
      { error: `Too many devices in one batch (max ${MAX_BULK_DEVICES}).` },
      { status: 400 },
    );
  }

  const parsed = parseAdminCommandBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const concurrency =
    typeof body.concurrency === "number" && Number.isInteger(body.concurrency)
      ? body.concurrency
      : undefined;

  try {
    const { batchId, targets } = await runAdminDeviceCommandBatch({
      deviceIds,
      cmd: parsed.cmd,
      shell: parsed.shell,
      timeoutSeconds: parsed.timeoutSeconds,
      runAsUser: parsed.runAsUser,
      concurrency,
    });
    return NextResponse.json({
      ok: true,
      batchId,
      total: targets.length,
      okCount: targets.filter((t) => t.ok).length,
      failedCount: targets.filter((t) => !t.ok).length,
      targets,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "batch_failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const batchId = new URL(req.url).searchParams.get("batchId");
  if (!batchId) return NextResponse.json({ error: "batchId is required." }, { status: 400 });

  const batch = await getAdminCommandBatch(batchId);
  return NextResponse.json({ ok: true, ...batch });
}
