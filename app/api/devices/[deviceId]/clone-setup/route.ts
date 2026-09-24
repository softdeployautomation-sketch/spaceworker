import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { cloneSetupStatus, setupCloneDevice, type CloneSetupRole } from "@/lib/clone-setup";

export const dynamic = "force-dynamic";

// TASK_114 — one-click clone-device setup (owner 2026-09-24: everything
// clickable, nobody installs anything by hand).
//   GET  → what this device already has (relay row, capabilities, online)
//   POST { role: "source" | "hosted" } → install + register, step by step.
//
// Manual own-device action, no approval rail (same posture as Ping / Run now /
// maintenance): approvals exist for AGENT-initiated requests, not for the owner
// setting up their own PC. Every step the route triggers is audited by the
// transport it uses (`device_run_now`, `browser-clone` relay-install).
//
// Responses are JSON on every path, with the device's own step results so a
// refusal names the step that failed rather than a generic "setup failed".

const ROLES: readonly CloneSetupRole[] = ["source", "hosted"];

function errorStatus(code: string): number {
  if (code === "device_not_owned") return 404;
  if (code === "device_not_linked") return 404;
  if (code === "device_offline") return 502;
  // A second setup while one is running is a CONFLICT, not a bad gateway: the
  // first run is intact and the caller should simply wait (see setupInFlight).
  if (code === "setup_already_running") return 409;
  if (code === "clone_engine_dist_missing" || code === "clone_engine_dist_invalid") return 503;
  if (code === "clone_engine_dist_incomplete") return 503;
  if (code.startsWith("vantra_deploy_outdated") || code === "vantra_not_configured") return 503;
  return 502;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;
  try {
    const status = await cloneSetupStatus({ userId: session.userId, deviceId });
    return NextResponse.json({ ok: true, deviceId, ...status });
  } catch (err) {
    const code = err instanceof Error ? err.message : "clone_setup_status_failed";
    return NextResponse.json({ error: code }, { status: errorStatus(code) });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const role = body.role;
  if (typeof role !== "string" || !ROLES.includes(role as CloneSetupRole)) {
    return NextResponse.json({ error: "role must be source or hosted." }, { status: 400 });
  }

  try {
    const result = await setupCloneDevice({
      userId: session.userId,
      deviceId,
      role: role as CloneSetupRole,
    });
    return NextResponse.json({ deviceId, ...result });
  } catch (err) {
    const code = err instanceof Error ? err.message : "clone_setup_failed";
    return NextResponse.json({ error: code }, { status: errorStatus(code) });
  }
}
