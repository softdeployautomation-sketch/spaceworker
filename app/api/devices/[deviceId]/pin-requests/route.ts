import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { listPinRequests } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// Task 95 — PIN request status for a device (owner's own session only).
// The PIN itself is readable once submitted — by its owner, in their session,
// from the device console. Rows are prunable; the token is stored only as a
// hash and never leaves this table.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    const requests = await listPinRequests({ userId: session.userId, deviceId });
    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    const code = err instanceof Error ? err.message : "pin_list_failed";
    const status = code === "device_not_linked" ? 404 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}
