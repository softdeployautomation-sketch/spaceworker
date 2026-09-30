import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { listAdminDevicesForUser } from "@/lib/admin-devices";

export const dynamic = "force-dynamic";

// TASK_146 — GET /api/admin/users/[id]/devices
//
// "Enter a user, see every machine they have" — the drill-down the admin needs
// before running anything, so a command is chosen against a real, current list
// (status + idle + OS) instead of a device id copied from somewhere else.
//
// Same read model as /api/admin/devices (one selector, one status derivation),
// just pinned to one owner, which also switches idle enrichment on — see
// listAdminDevices() on why that is per-user only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params; // MUST await — async in Next.js 16
  try {
    const { owner, devices } = await listAdminDevicesForUser(id);
    if (!owner) return NextResponse.json({ error: "User not found" }, { status: 404 });
    return NextResponse.json({ ok: true, owner, count: devices.length, devices });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "list_failed" },
      { status: 500 },
    );
  }
}
