import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  cancelQueuedCommand,
  createQueuedCommand,
  listQueuedCommands,
} from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// Task 95 — queued commands for a device (the "timed command for an offline
// device" tool). Vantra's online-transition sweep fires them when the device
// checks in; this surface lists (with live status), queues, and cancels.
//   GET                      → the user's queued commands for this device
//   POST {cmd,shell,timeout,runAsUser} → queue (mirrors Vantra's row)
//   DELETE {queuedCommandId} → cancel (only while still queued)

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    const commands = await listQueuedCommands({ userId: session.userId, deviceId });
    return NextResponse.json({ ok: true, commands });
  } catch (err) {
    const code = err instanceof Error ? err.message : "queue_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "vantra_not_configured" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { cmd?: unknown; shell?: unknown; timeout?: unknown; runAsUser?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const cmd = typeof body.cmd === "string" ? body.cmd.trim() : "";
  if (!cmd || cmd.length > 8000) {
    return NextResponse.json({ error: "cmd is required (max 8000 chars)." }, { status: 400 });
  }
  const shell = body.shell === "cmd" ? "cmd" : "powershell";
  const timeoutSeconds =
    typeof body.timeout === "number" && Number.isInteger(body.timeout) && body.timeout >= 1 && body.timeout <= 90
      ? body.timeout
      : 30;
  const runAsUser = body.runAsUser === true;

  try {
    const command = await createQueuedCommand({
      userId: session.userId,
      deviceId,
      cmd,
      shell,
      timeoutSeconds,
      runAsUser,
    });
    return NextResponse.json({ ok: true, command }, { status: 201 });
  } catch (err) {
    const code = err instanceof Error ? err.message : "queue_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "vantra_not_configured" ? 503
      : String(code).startsWith("vantra_4") ? 400
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { queuedCommandId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const queuedCommandId = typeof body.queuedCommandId === "string" ? body.queuedCommandId : "";
  if (!queuedCommandId) {
    return NextResponse.json({ error: "queuedCommandId is required." }, { status: 400 });
  }

  try {
    await cancelQueuedCommand({ userId: session.userId, deviceId, queuedCommandId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : "cancel_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "not_queued" ? 409
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
