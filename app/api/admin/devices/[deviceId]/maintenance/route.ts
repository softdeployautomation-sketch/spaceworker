import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { adminCommandErrorStatus, splitDeviceError } from "@/lib/admin-devices";
import { adminRunMaintenanceOverlay } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_148 — POST /api/admin/devices/[deviceId]/maintenance
//
// The maintenance overlay, as the admin, on ANY device. SILENT console-side: it
// writes AdminDeviceCommand (kind "maintenance") and NOT recordAgentActionAudit,
// so nothing appears in the owner's activity stream.
//
// It is NOT silent device-side, and cannot be: the overlay covers the physical
// screen. Whoever is at the machine sees it. That is the tool, not a leak.
//
// The counterpart of app/api/devices/[deviceId]/maintenance/route.ts, minus the
// session-ownership gate (the admin session IS the authorization; the owner is
// read off our own device row) and minus the custom-image upload, which needs a
// file picker on a screen that is currently a live viewer.
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let body: { action?: unknown; style?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action === "stop" ? "stop" : body.action === "start" ? "start" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be start or stop" }, { status: 400 });
  }
  // Server-validated enum; anything unrecognised falls back to the default
  // rather than being forwarded to the agent.
  const style = body.style === "exe" ? "exe" : body.style === "update" ? "update" : undefined;

  try {
    const result = await adminRunMaintenanceOverlay({ deviceId, action, style });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const { code, message } = splitDeviceError(err);
    return NextResponse.json({ error: message, code }, { status: adminCommandErrorStatus(code) });
  }
}
