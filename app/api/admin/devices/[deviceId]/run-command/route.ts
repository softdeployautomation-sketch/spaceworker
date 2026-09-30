import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import {
  adminCommandErrorStatus,
  listAdminCommandLog,
  parseAdminCommandBody,
  splitDeviceError,
} from "@/lib/admin-devices";
import { adminRunDeviceCommand } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_146 — POST /api/admin/devices/[deviceId]/run-command
//
// Run ONE PowerShell (or cmd) command on ONE device, as the admin. SILENT: the
// result lands in AdminDeviceCommand only, never on the owner's stream/digest/
// console — see the executor's comment in lib/device-tools.ts.
//
// The device is addressed by OUR device id, and the owner is read off the row,
// so the admin never has to know (or be trusted with) a customer's user id, and
// a forged device id can never be rerouted to another owner's machine: Vantra
// asserts the agent belongs to the `sw-<userId>` org derived from that row.
//
//   POST {cmd, shell, timeout, runAsUser} → { ok, output, ranAt, ... }
//   GET                                   → this device's admin command log
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let body: { cmd?: unknown; shell?: unknown; timeout?: unknown; runAsUser?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseAdminCommandBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const result = await adminRunDeviceCommand({
      deviceId,
      cmd: parsed.cmd,
      shell: parsed.shell,
      timeoutSeconds: parsed.timeoutSeconds,
      runAsUser: parsed.runAsUser,
    });
    return NextResponse.json({
      ok: true,
      commandId: result.commandId,
      deviceId: result.deviceId,
      deviceName: result.deviceName,
      output: result.output,
      ranAt: result.ranAt,
    });
  } catch (err) {
    const { code, message } = splitDeviceError(err);
    return NextResponse.json(
      { error: message, code },
      { status: adminCommandErrorStatus(code) },
    );
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { deviceId } = await params;
  const commands = await listAdminCommandLog({ deviceId });
  return NextResponse.json({ ok: true, commands });
}
