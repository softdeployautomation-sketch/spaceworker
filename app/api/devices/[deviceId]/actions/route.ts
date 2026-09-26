import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  createDeviceActionProposal,
  DeviceActionKind,
} from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — create a gated device-action proposal. The device-side effect
// happens ONLY on approval (POST /api/devices/actions/[pendingActionId]).
const KINDS: readonly string[] = [
  "wake",
  "reboot",
  "shutdown",
  "run-script",
  "cmd",
  // Task 95 — Devices v2 tool parity.
  "remote-control",
  "maintenance-start",
  "maintenance-stop",
  "pin-request",
];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: {
    kind?: unknown;
    scriptId?: unknown;
    args?: unknown;
    timeout?: unknown;
    command?: unknown;
    pinLength?: unknown;
    scheduleKind?: unknown;
    wakeDelayMinutes?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: "Unknown action kind" }, { status: 400 });
  }

  const payload: Record<string, unknown> = {};
  if (body.scriptId !== undefined) payload.scriptId = Number(body.scriptId);
  if (Array.isArray(body.args)) payload.args = body.args.map(String);
  if (body.timeout !== undefined) payload.timeout = Number(body.timeout);
  if (typeof body.command === "string") payload.command = body.command;
  // Task 95 — PIN length (4/6/8), validated at execution time too.
  if (body.pinLength !== undefined) {
    const pinLength = Number(body.pinLength);
    if (pinLength !== 4 && pinLength !== 6 && pinLength !== 8) {
      return NextResponse.json({ error: "pinLength must be 4, 6, or 8" }, { status: 400 });
    }
    payload.pinLength = pinLength;
  }
  // Queued PIN collect (2026-10) — prompt fires when the device comes on.
  if (body.scheduleKind !== undefined) {
    const sk = String(body.scheduleKind);
    if (sk !== "next_checkin" && sk !== "after_wake") {
      return NextResponse.json({ error: "scheduleKind must be next_checkin or after_wake" }, { status: 400 });
    }
    payload.scheduleKind = sk;
    const wdm = Number(body.wakeDelayMinutes) || 0;
    if (wdm < 0 || wdm > 7 * 24 * 60) {
      return NextResponse.json({ error: "wakeDelayMinutes out of range" }, { status: 400 });
    }
    payload.wakeDelayMinutes = wdm;
  }

  try {
    const result = await createDeviceActionProposal({
      userId: session.userId,
      deviceId,
      kind: kind as DeviceActionKind,
      payload,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (err) {
    const code = err instanceof Error ? err.message : "proposal_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "device_actions_disabled" || code === "device_actions_limit" ? 429
      : code === "agent_actions_disabled" ? 403
      : code === "vantra_not_configured" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}