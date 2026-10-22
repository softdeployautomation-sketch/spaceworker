import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import { createScript, listScripts } from "@/lib/device-scripts";
import { scriptErrorResponse } from "@/lib/script-http";

export const dynamic = "force-dynamic";

// GET  /api/scripts  — the user's saved scripts (+ their auto-enroll rules).
// POST /api/scripts  — create one.
//
// Reading is free; every route that can reach a device (run/auto) is gated by
// deviceToolsDenied, exactly like the console's Run-now.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ scripts: await listScripts(session.userId) });
  } catch (err) {
    return scriptErrorResponse(err);
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const script = await createScript(session.userId, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : null,
      shell: typeof body.shell === "string" ? body.shell : "powershell",
      body: typeof body.body === "string" ? body.body : "",
      timeoutSeconds: Number(body.timeoutSeconds) || 90,
    });
    return NextResponse.json({ script }, { status: 201 });
  } catch (err) {
    return scriptErrorResponse(err);
  }
}
