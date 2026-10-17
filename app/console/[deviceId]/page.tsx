import type { Metadata } from "next";

import { DeviceConsole } from "@/components/device-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Device console — SpaceWorker OS" };

// TASK_216 D1 — session-gated server page (a baked gate bounces/blanks users
// the same way it baked /cyberlab's 307 — see that page's comment).
export const dynamic = "force-dynamic";

// TASK_103 BUG-A — the chrome-free full-screen console. Top-level route
// (OUTSIDE app/dashboard/*, so the <Shell> menubar + dock never render):
// just the session window + its toolbox line. `?tab=` selects the initial
// tab (`remote` = Remote control; default `remote` — the owner opens this
// from Remote control via the expand button). TASK_152 M2 added `monitoring`.
const TAB_ALIASES: Record<string, "summary" | "control" | "command" | "clone" | "activity" | "monitoring"> = {
  summary: "summary",
  remote: "control",
  control: "control",
  command: "command",
  clone: "clone",
  activity: "activity",
  monitoring: "monitoring",
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
    // TASK_212 D5 — full-screen fills the viewport in EITHER orientation:
    // `h-[100dvh]` tracks the on-screen keyboard / address bar as it shows and
    // hides, and the max() padding keeps the window clear of notches and the
    // home indicator now that viewportFit: "cover" (app/layout.tsx) lets
    // content run under them. DeviceConsole's outer wrapper is flex-1/min-h-0
    // inside this, so no component needs a viewport calc of its own any more
    // (the old `h-[calc(100vh-3rem)]` lived in ControlTab). Desktop keeps
    // byte-identical margins: max() falls back to py-6/px-4 when the insets
    // are 0.
    <main className="mx-auto flex h-[100dvh] w-full max-w-6xl flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <DeviceConsole deviceId={deviceId} fullScreen initialTab={initialTab} />
    </main>
  );
}
