import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { runPowerAction } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

const ACTIONS = ["reboot", "shutdown", "wake"] as const;

// TASK_103 MISSING-2 — direct power path for MANUAL users. Manual own-device
// actions execute immediately (audited as `web-direct`); the proposal rail
// stays in place for AGENT-initiated power actions (which still need approval).
//   POST { action: "reboot" | "shutdown" | "wake" } → { ok, action }
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
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    return NextResponse.json({ error: "action must be reboot, shutdown, or wake" }, { status: 400 });
  }

  try {
    await runPowerAction({
      userId: session.userId,
      deviceId,
      action: action as (typeof ACTIONS)[number],
    });
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    const code = err instanceof Error ? err.message : "power_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "vantra_not_configured" ? 503
      : String(code).startsWith("vantra_503") ? 503
      : String(code).startsWith("vantra_4") ? 400
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
