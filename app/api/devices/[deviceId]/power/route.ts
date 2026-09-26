import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  getDevicePowerView,
  runPowerAction,
  setPowerPolicy,
  type PowerPolicyMode,
} from "@/lib/device-tools";

export const dynamic = "force-dynamic";

const POWER_ACTIONS = ["reboot", "shutdown", "wake"] as const;
const POLICY_MODES = ["off", "timed", "indefinite"] as const;

function statusForError(code: string): number {
  if (code === "device_not_linked") return 404;
  if (code === "vantra_not_configured") return 503;
  if (code === "no_power_mac" || code === "no_same_subnet_peer") return 409;
  if (code === "peer_unreachable") return 409;
  if (code === "unsupported") return 503;
  if (code === "wake_no_packets_sent" || code === "wake_failed" || code === "keep_awake_apply_failed") return 502;
  if (code.startsWith("vantra_503")) return 503;
  if (code.startsWith("vantra_4")) return 400;
  return 502;
}

// TASK_103 MISSING-2 / TASK_123 (B12) — direct power path for MANUAL users.
// Manual own-device actions execute immediately (audited as `web-direct`);
// the proposal rail stays for AGENT-initiated power actions.
//
//   POST { action: "reboot" | "shutdown" | "wake" }
//     → { ok, action, packetsSent? }  (packetsSent only ever set for "wake")
//   POST { action: "keep_awake", mode: "off" | "timed" | "indefinite", minutes? }
//     → { ok, policy: { mode, until } }
//
// Refusal vocabulary added by TASK_123 D3 — wake NEVER returns `ok: true`
// for these: "no_power_mac" (setup hasn't recorded a MAC yet — rerun setup),
// "no_same_subnet_peer" (no online device shares this one's /24 — keep a
// second PC on the same LAN online, or use keep-awake instead),
// "wake_no_packets_sent" (the peer ran but sent zero packets — D6).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { action?: unknown; mode?: unknown; minutes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "keep_awake") {
    const mode = typeof body.mode === "string" ? body.mode : "";
    if (!POLICY_MODES.includes(mode as (typeof POLICY_MODES)[number])) {
      return NextResponse.json({ error: "mode must be off, timed, or indefinite" }, { status: 400 });
    }
    const minutes = typeof body.minutes === "number" ? body.minutes : undefined;
    try {
      const policy = await setPowerPolicy({
        userId: session.userId,
        deviceId,
        mode: mode as PowerPolicyMode,
        minutes,
      });
      return NextResponse.json({ ok: true, policy });
    } catch (err) {
      const code = err instanceof Error ? err.message : "keep_awake_failed";
      return NextResponse.json({ error: code }, { status: statusForError(code) });
    }
  }

  if (!POWER_ACTIONS.includes(action as (typeof POWER_ACTIONS)[number])) {
    return NextResponse.json(
      { error: "action must be reboot, shutdown, wake, or keep_awake" },
      { status: 400 },
    );
  }

  try {
    const result = await runPowerAction({
      userId: session.userId,
      deviceId,
      action: action as (typeof POWER_ACTIONS)[number],
    });
    return NextResponse.json({ ok: true, action, packetsSent: result.packetsSent });
  } catch (err) {
    const code = err instanceof Error ? err.message : "power_failed";
    return NextResponse.json({ error: code }, { status: statusForError(code) });
  }
}

// P5 — read-only power state: current keep-awake policy + whether Wake would
// currently succeed, and why not when it wouldn't. Never sends anything to
// the device (getDevicePowerView is a pure DB read plus, if a timed policy
// has expired, a self-healing Stop — see sweepIfExpired's doc comment).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;
  try {
    const view = await getDevicePowerView({ userId: session.userId, deviceId });
    return NextResponse.json(view);
  } catch (err) {
    const code = err instanceof Error ? err.message : "power_view_failed";
    return NextResponse.json({ error: code }, { status: statusForError(code) });
  }
}
