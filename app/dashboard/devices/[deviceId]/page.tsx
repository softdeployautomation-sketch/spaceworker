import type { Metadata } from "next";

import { DeviceConsole } from "@/components/device-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Device console — SpaceWorker OS" };

// Task 95 — the per-device console (ScreenConnect-style session window).
// Auth is checked here; the console client fetches its own live data.
export default async function DeviceConsolePage({
  params,
}: {
  params: Promise<{ deviceId: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  const { deviceId } = await params;
  return <DeviceConsole deviceId={deviceId} />;
}
