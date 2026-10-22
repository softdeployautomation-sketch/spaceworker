import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import {
  MAX_RUN_DEVICES,
  createScriptRuns,
  dispatchScriptRunsNow,
} from "@/lib/device-scripts";
import { db } from "@/lib/db";
import { scriptErrorResponse } from "@/lib/script-http";

export const dynamic = "force-dynamic";

// POST /api/scripts/:id/run
//   { deviceIds: string[], scheduledFor?: ISO string }
//
// No scheduledFor → run now (first few dispatched inline, rest by the sweep).
// scheduledFor in the future → queued; the once-a-minute sweep fires it.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ scriptId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { scriptId } = await params;

  let body: { deviceIds?: unknown; scheduledFor?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const deviceIds = Array.isArray(body.deviceIds)
    ? body.deviceIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
  if (!deviceIds.length || deviceIds.length > MAX_RUN_DEVICES) {
    return NextResponse.json({ error: "no_devices" }, { status: 400 });
  }

  let scheduledFor: Date | null = null;
  if (typeof body.scheduledFor === "string" && body.scheduledFor.trim()) {
    const parsed = new Date(body.scheduledFor);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "invalid_schedule" }, { status: 400 });
    }
    if (parsed.getTime() > Date.now() + 5_000) scheduledFor = parsed;
  }

  try {
    const runIds = await createScriptRuns({
      userId: session.userId,
      scriptId,
      deviceIds,
      trigger: scheduledFor ? "scheduled" : "manual",
      scheduledFor,
    });
    if (!scheduledFor) await dispatchScriptRunsNow(runIds);

    const runs = runIds.length
      ? await db.deviceScriptRun.findMany({
          where: { id: { in: runIds } },
          select: {
            id: true,
            deviceId: true,
            status: true,
            output: true,
            exitCode: true,
            error: true,
            scheduledFor: true,
          },
        })
      : [];
    return NextResponse.json({ ok: true, scheduled: !!scheduledFor, runs });
  } catch (err) {
    return scriptErrorResponse(err);
  }
}
