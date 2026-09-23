import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { runCommandNow } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// 2026-10 console follow-up — INSTANT command on an ONLINE device ("Run now"
// in the Command tab). Owner's explicit call: synchronous, no approval rail
// (same posture as manual Connect / maintenance). Vantra executes through its
// TRMM-keyed /action route, tenant-asserted to the caller's sw-* org.
//   POST {cmd, shell, timeout, runAsUser} → { ok, output }

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
  const timeout =
    typeof body.timeout === "number" && Number.isInteger(body.timeout) && body.timeout >= 1 && body.timeout <= 90
      ? body.timeout
      : 30;
  const runAsUser = body.runAsUser === true;

  try {
    const result = await runCommandNow({
      userId: session.userId,
      deviceId,
      cmd,
      shell,
      timeoutSeconds: timeout,
      runAsUser,
    });
    return NextResponse.json({ ok: true, output: result.output, ranAt: result.ranAt });
  } catch (err) {
    const code = err instanceof Error ? err.message : "run_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "cmd_invalid" ? 400
      : code === "vantra_not_configured" ? 503
      : code === "vantra_deploy_outdated" ? 503
      : String(code).startsWith("vantra_4") ? 400
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
