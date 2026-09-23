import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  startMaintenanceOverlayAction,
  stopMaintenanceOverlayAction,
} from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// 2026-10 owner rule — MANUAL maintenance overlay is a NORMAL console action:
// start/stop executes IMMEDIATELY, with NO proposal rail. The approval gate
// exists exclusively for AGENT-initiated requests ("approvals are for agents
// only, not for manual users"), so this mirrors the manual posture of Connect,
// Run now and PIN collect.
//
// The overlay itself is device-side only: it covers the screen physically at
// the machine, is excluded from remote KVM capture, and is click-through — the
// person at the device sees the maintenance screen while the technician keeps
// full control (see Vantra lib/maintenance-overlay.ts).
//   POST { action: "start" | "stop" } → { ok, action }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ error: "action must be start or stop" }, { status: 400 });
  }

  try {
    if (action === "stop") {
      await stopMaintenanceOverlayAction({
        userId: session.userId,
        deviceId,
        approvalChannel: "web-direct",
      });
    } else {
      await startMaintenanceOverlayAction({
        userId: session.userId,
        deviceId,
        approvalChannel: "web-direct",
      });
    }
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    const code = err instanceof Error ? err.message : "maintenance_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "vantra_not_configured" ? 503
      : code === "vantra_deploy_outdated" ? 503
      // Vantra answers 503 "This device is currently offline." — the console
      // strips the prefix and shows the human sentence.
      : String(code).startsWith("vantra_503") ? 503
      : String(code).startsWith("vantra_4") ? 400
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
