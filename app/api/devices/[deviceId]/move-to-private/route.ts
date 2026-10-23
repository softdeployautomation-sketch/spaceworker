import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import { prisma } from "@/lib/prisma";
import { moveAgentToPrivateOrg, runCommandNow } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_228 — "Move to private" (owner redesign 2026-10-19).
// POST /api/devices/[deviceId]/move-to-private
//
// The ONLY way a device leaves the public org now: an explicit click on the
// device row. The silent auto-move is retired for sw- orgs (its two-step
// script rewrote the agent's BaseURL and force-restarted `tacticalrmm`,
// stranding boxes that were offline mid-move — "a lot of devices have gone
// missing after getting on").
//
// Direct-execute, like every other manual console tool (Wake/Reboot/Run now):
// the approval rail exists for AGENT-initiated requests, not a user's own
// click. Ownership: the row is matched on { id, userId } (404 for someone
// else's device — no existence oracle), and the move re-checks through
// requireOwnedDevice + Vantra's sw- tenant guard on the far side.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { deviceId } = await params;

  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId: session.userId },
    select: { id: true, tier: true },
  });
  if (!device) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (device.tier === "private") {
    return NextResponse.json({ error: "already_private" }, { status: 409 });
  }

  try {
    const result = await moveAgentToPrivateOrg({ userId: session.userId, deviceId });
    if (!result.ok) {
      // Vantra's D6 shape: HTTP 200 { ok:false, reason } — a business refusal
      // (no private companion org yet, or the move step itself failed) maps to
      // 409/502 so the UI can say WHY instead of failing silently.
      const status = result.reason === "no_private_org" ? 409 : 502;
      return NextResponse.json({ error: result.reason }, { status });
    }
    // Fire-and-forget: dispatch the private install command to the device.
    // The PowerShell installer runs on the device in the background (1–3 min);
    // we return 200 immediately so the browser does not wait. Errors are
    // swallowed: if the device was offline the install simply did not start;
    // the owner will see the device remain in Public and can retry.
    void runCommandNow({
      userId: session.userId,
      deviceId,
      cmd: result.install?.singleLine ?? result.install?.command ?? "",
      shell: "powershell",
      timeoutSeconds: 30,
      runAsUser: false,
    }).catch((err) => {
      console.error(
        "[move-to-private] install dispatch error:",
        err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      );
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : "move_failed";
    return NextResponse.json({ error: code.slice(0, 200) }, { status: 502 });
  }
}
