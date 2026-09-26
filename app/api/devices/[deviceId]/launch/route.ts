import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { launchApp } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_104 §2 (PATH A) — the silent app launcher's launch action. Manual
// own-device, no approval, audited `web-direct`. Accepts exactly one of a
// discovered app key, an absolute Windows path, or an https:// URL —
// anything else is refused by lib/device-tools.ts's launchApp before any
// command reaches the device (see its own doc comment for the full
// fail-closed rule).
//   POST { target: string } -> { ok, kind } | { ok: false, kind, error }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  let body: { target?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const target = typeof body.target === "string" ? body.target : "";
  if (!target.trim()) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }

  try {
    const result = await launchApp({ userId: session.userId, deviceId, target });
    return NextResponse.json({ ok: result.ok, kind: result.kind, ...(result.error ? { error: result.error } : {}) });
  } catch (err) {
    const code = err instanceof Error ? err.message : "launch_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "bad_target" || code === "unknown_launch_target" ? 400
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
