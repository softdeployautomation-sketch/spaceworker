import type { Metadata } from "next";

import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Cyber Lab — SpaceWorker OS" };

// TASK_156B UI-1 → V2 (Slice 1) — the lab section used to force its own
// always-dark canvas; it now follows the SAME app-wide light/dark toggle as the
// rest of the product (the `.dark` class on <html>, set in the root layout's
// inline script + toggled by components/theme-toggle.tsx). The `.lab-ops` class
// (app/globals.css) provides a light "blueprint console" palette by default and
// a near-black SOC canvas under `.dark`, so entering /cyberlab still feels like
// its own place — but honours the theme toggle. The min-h-screen + bg paint the
// full viewport behind the console before the client mounts.
export default function CyberLabLayout({ children }: { children: ReactNode }) {
  return <div className="lab-ops min-h-screen">{children}</div>;
}
