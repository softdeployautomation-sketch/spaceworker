import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { listAdminDevices } from "@/lib/admin-devices";

export const dynamic = "force-dynamic";

// TASK_146 — GET /api/admin/devices
//
// Every device across every owner. The admin-only counterpart of
// app/api/devices/route.ts (which is scoped to `session.userId`); this route
// asserts the admin session ITSELF, exactly like every other route under
// app/api/admin/** — the protected page layout does not cover the API tree.
//
//   ?q=      substring of device name OR owner email
//   ?status= online | offline (matched against the DERIVED status, so it can't
//            contradict the badge the panel renders)
//   ?userId= pin to one owner (the Users-tab drill-down)
//   ?removed=1  TASK_188 S3 — ONLY soft-deleted rows (the Deleted subtab).
//            DEFAULT (flag absent) still excludes them byte-for-byte, so every
//            existing caller is unaffected.
//
// Read-only: no command is ever run from a GET, so this cannot be CSRF'd into
// touching a machine.
export async function GET(req: Request) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  try {
    const { devices, truncated } = await listAdminDevices({
      q: url.searchParams.get("q") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      userId: url.searchParams.get("userId") ?? undefined,
      removed: url.searchParams.get("removed") === "1",
    });
    return NextResponse.json({ ok: true, count: devices.length, truncated, devices });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "list_failed" },
      { status: 500 },
    );
  }
}
