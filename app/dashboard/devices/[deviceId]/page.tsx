import type { Metadata } from "next";

import { DeviceConsole } from "@/components/device-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Device console — SpaceWorker OS" };

// Task 95 — the per-device console (ScreenConnect-style session window).
// Auth is checked here; the console client fetches its own live data.
// ?full=1 (2026-10) — "open in new tab": console alone, no page chrome.
export default async function DeviceConsolePage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<{ full?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  const { deviceId } = await params;
  const { full } = await searchParams;
  return <DeviceConsole deviceId={deviceId} fullScreen={full === "1"} />;
}
