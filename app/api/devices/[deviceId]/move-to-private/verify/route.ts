import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deviceToolsDenied } from "@/lib/device-gate";
import { verifyMoveToPrivate } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_236 — step 2 (VERIFY) of install→verify→remove.
// POST /api/devices/[deviceId]/move-to-private/verify
//
// Read-only. Asks Vantra whether the device has re-appeared under the PRIVATE
// companion org yet (hostname match against the private client's agent list).
//
// The policy this endpoint exists to enforce: the PUBLIC row is never deleted
// automatically. This route only REPORTS whether the private copy is live;
// once it says verified, the USER deletes the public row themselves from the
// device list. There is no removal call on this path — and no way to reach one
// without an explicit, verified, user-initiated action.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await deviceToolsDenied(session.userId);
  if (denied) return denied;
  const { deviceId } = await params;

  try {
    const result = await verifyMoveToPrivate({ userId: session.userId, deviceId });
    if (!result.ok) {
      // Vantra's D6 shape: HTTP 200 { ok:false, reason } — a business refusal
      // (no private companion org yet, or TRMM unreachable) maps to 409/502 so
      // the UI can say WHY instead of failing silently.
      const status = result.reason === "no_private_org" ? 409 : 502;
      return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json({
      ok: true,
      verified: result.verified,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.privateAgentId ? { privateAgentId: result.privateAgentId } : {}),
      ...(result.hostname ? { hostname: result.hostname } : {}),
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "verify_failed";
    return NextResponse.json({ error: code.slice(0, 200) }, { status: 502 });
  }
}
