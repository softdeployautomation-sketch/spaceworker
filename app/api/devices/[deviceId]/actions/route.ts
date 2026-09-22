import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import {
  createDeviceActionProposal,
  DeviceActionKind,
} from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — create a gated device-action proposal. The device-side effect
// happens ONLY on approval (POST /api/devices/actions/[pendingActionId]).
const KINDS: readonly string[] = ["wake", "reboot", "shutdown", "run-script", "cmd"];

export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { kind?: unknown; scriptId?: unknown; args?: unknown; timeout?: unknown; command?: unknown };
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
      : code === "vantra_not_configured" ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}