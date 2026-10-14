import type { Metadata } from "next";

import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Cyber Lab — SpaceWorker OS" };

// TASK_156B UI-1 (owner gate 3 approved: the lab theme MAY diverge from the
// dashboard palette). The `.lab-ops` class is the always-dark SOC canvas the
// whole section ships in (app/globals.css) — independent of the Night Studio
// light/dark toggle, so /cyberlab looks like its own place. The min-h-screen
// + bg paint the full viewport behind the console (the component's own
// `.lab-ops` wrapper re-asserts it, but doing it here too avoids any flash of
// the light body colour before the client mounts).
export default function CyberLabLayout({ children }: { children: ReactNode }) {
  return <div className="lab-ops min-h-screen">{children}</div>;
}
