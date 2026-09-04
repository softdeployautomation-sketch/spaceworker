import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";

// POST /api/admin/queue/dispatch — lets an admin manually fire one dispatch
// tick from the panel (e.g. to confirm the pipeline is alive after a fix,
// without waiting up to 10s for the next timer tick). Forwards to the real
// internal dispatch endpoint server-side so the INTERNAL_BEARER_TOKEN never
// reaches the browser.
export async function POST() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = process.env.INTERNAL_BEARER_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "INTERNAL_BEARER_TOKEN not configured" }, { status: 500 });
  }

  try {
    // process.env.PORT is always set in real deployments (systemd's
    // EnvironmentFile loads it) — the fallback below only matters if it's
    // somehow missing. Set to 3500 to match the actual production .env
    // (confirmed directly on the VPS), not .env.example's stale "3400".
    const res = await fetch(`http://localhost:${process.env.PORT ?? 3500}/api/internal/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ error: "Dispatch call failed", detail: data }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "Couldn't reach the dispatch endpoint", detail: String(err) },
      { status: 502 }
    );
  }
}
