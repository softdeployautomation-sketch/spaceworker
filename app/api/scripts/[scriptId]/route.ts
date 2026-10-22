import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import { archiveScript, updateScript } from "@/lib/device-scripts";
import { scriptErrorResponse } from "@/lib/script-http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ scriptId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { scriptId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const script = await updateScript(session.userId, scriptId, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : null,
      shell: typeof body.shell === "string" ? body.shell : "powershell",
      body: typeof body.body === "string" ? body.body : "",
      timeoutSeconds: Number(body.timeoutSeconds) || 90,
    });
    return NextResponse.json({ script });
  } catch (err) {
    return scriptErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { scriptId } = await params;
  try {
    await archiveScript(session.userId, scriptId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return scriptErrorResponse(err);
  }
}
