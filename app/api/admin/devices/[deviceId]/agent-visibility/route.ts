import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { adminCommandErrorStatus, splitDeviceError } from "@/lib/admin-devices";
import { adminSetAgentVisibility } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_148 — POST /api/admin/devices/[deviceId]/agent-visibility
//
// Hide / reveal the Tactical agent's identity on ANY device, as the admin.
//
// SILENT console-side: AdminDeviceCommand (kind "agent-visibility") and NOT
// recordAgentActionAudit, so the owner's activity stream shows nothing. The
// script is the SAME builder the owner's console uses, so "hidden" has one
// definition and the two paths cannot drift.
//
// NOT silent device-side: a hidden agent renames a real Windows service and
// removes the Apps-list entry. Anyone opening services.msc can see it. The
// console is explicit that this is cosmetic — a local admin can still stop,
// reveal or uninstall it — and that is exactly why it must not be presented as
// concealment from the machine's own user.
//
//   POST { mode: "hide" | "reveal", label?: string }
export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { deviceId } = await params;

  let body: { mode?: unknown; label?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mode = body.mode === "hide" ? "hide" : body.mode === "reveal" ? "reveal" : null;
  if (!mode) {
    return NextResponse.json({ error: "mode must be hide or reveal" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label : undefined;

  try {
    const result = await adminSetAgentVisibility({ deviceId, mode, label });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const { code, message } = splitDeviceError(err);
    // An invalid label is the caller's fault, not a bad gateway — the builder
    // refuses anything that could escape the PowerShell it constructs.
    if (code === "agent_label_invalid") {
      return NextResponse.json(
        { error: "Label must be 1–80 characters: letters, digits, spaces, hyphens only.", code },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: message, code }, { status: adminCommandErrorStatus(code) });
  }
}
