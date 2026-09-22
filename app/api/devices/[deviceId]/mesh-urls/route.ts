import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { fetchMeshUrls } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// Task 95 — MeshCentral URLs for the remote-control viewer. Approval-scoped:
// pass ?pendingActionId=<executed remote-control action> minted within the
// last 10 minutes; the ownership + freshness gate lives in fetchMeshUrls.
// (wake/reboot/etc. stay blocking server calls; this is the one output that
// must reach the browser so the iframe can load.)

export async function GET(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;
  const pendingActionId = new URL(req.url).searchParams.get("pendingActionId") ?? undefined;

  try {
    const urls = await fetchMeshUrls({ userId: session.userId, deviceId, pendingActionId });
    return NextResponse.json({ ok: true, urls });
  } catch (err) {
    const code = err instanceof Error ? err.message : "mesh_urls_failed";
    const status =
      code === "device_not_linked" ? 404
      : code === "no_active_grant" ? 403
      : code === "vantra_not_configured" ? 503
      : String(code).startsWith("vantra_503") ? 503
      : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
