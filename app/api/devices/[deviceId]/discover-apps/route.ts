import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { discoverApps, getLauncherApps } from "@/lib/device-tools";

export const dynamic = "force-dynamic";

// TASK_104 §1 (PATH A) — the silent app launcher's catalog. Manual
// own-device, no approval, same posture as Ping/Run now elsewhere in this
// file family.
//   GET  -> the last-discovered catalog, no device round trip
//           { ok, apps, discoveredAt }
//   POST -> re-run discovery on the device now (online required; an offline
//           device fails immediately, no queue row) and cache the result
//           { ok, apps, discoveredAt }

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    const { apps, discoveredAt } = await getLauncherApps({ userId: session.userId, deviceId });
    return NextResponse.json({ ok: true, apps, discoveredAt });
  } catch (err) {
    const code = err instanceof Error ? err.message : "discover_apps_failed";
    const status = code === "device_not_linked" ? 404 : 502;
    return NextResponse.json({ error: code }, { status });
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { deviceId } = await params;

  try {
    const apps = await discoverApps({ userId: session.userId, deviceId });
    return NextResponse.json({ ok: true, apps, discoveredAt: new Date().toISOString() });
  } catch (err) {
    const code = err instanceof Error ? err.message : "discover_apps_failed";
    const status = code === "device_not_linked" ? 404 : 502;
    // Offline / unreachable device: immediate failure, no queue row — same
    // rule as Ping and every other manual own-device tool in this family.
    return NextResponse.json({ error: code }, { status });
  }
}
