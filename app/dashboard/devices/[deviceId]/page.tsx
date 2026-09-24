import type { Metadata } from "next";

import { DeviceConsole } from "@/components/device-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Device console — SpaceWorker OS" };

// Task 95 — the per-device console (ScreenConnect-style session window).
// Auth is checked here; the console client fetches its own live data.
// TASK_103 BUG-A — `?tab=summary|remote|command|clone|activity` selects the
// initial tab (`remote` = Remote control). `?full=1` is kept working: it
// redirects to the chrome-free console so old links do not break.
const TAB_ALIASES: Record<string, "summary" | "control" | "command" | "clone" | "activity"> = {
  summary: "summary",
  remote: "control",
  control: "control",
  command: "command",
  clone: "clone",
  activity: "activity",
};

export default async function DeviceConsolePage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<{ full?: string; tab?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  const { deviceId } = await params;
  const { full, tab } = await searchParams;
  if (full === "1" && !tab) {
    const { redirect } = await import("next/navigation");
    redirect(`/console/${deviceId}?tab=remote`);
  }
  const key = typeof tab === "string" ? tab.trim().toLowerCase() : "";
  const initialTab = TAB_ALIASES[key] ?? (full === "1" ? "control" : "summary");
  return <DeviceConsole deviceId={deviceId} fullScreen={full === "1"} initialTab={initialTab} />;
}
