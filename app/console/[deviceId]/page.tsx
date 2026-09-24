import type { Metadata } from "next";

import { DeviceConsole } from "@/components/device-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Device console — SpaceWorker OS" };

// TASK_103 BUG-A — the chrome-free full-screen console. Top-level route
// (OUTSIDE app/dashboard/*, so the <Shell> menubar + dock never render):
// just the session window + its toolbox line. `?tab=` selects the initial
// tab (`remote` = Remote control; default `remote` — the owner opens this
// from Remote control via the expand button).
const TAB_ALIASES: Record<string, "summary" | "control" | "command" | "clone" | "activity"> = {
  summary: "summary",
  remote: "control",
  control: "control",
  command: "command",
  clone: "clone",
  activity: "activity",
};

export default async function FullScreenConsolePage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  const { deviceId } = await params;
  const { tab } = await searchParams;
  const key = typeof tab === "string" ? tab.trim().toLowerCase() : "";
  const initialTab = TAB_ALIASES[key] ?? "control";
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <DeviceConsole deviceId={deviceId} fullScreen initialTab={initialTab} />
    </main>
  );
}
