import type { Metadata } from "next";

import { ScriptsPanel } from "@/components/scripts-panel";

export const metadata: Metadata = { title: "Scripts — SpaceWorker OS" };

// 2026-10-22 — saved device scripts: run now (single or many), schedule, or
// auto-run N minutes after a public device enrolls.
export default function ScriptsPage() {
  return <ScriptsPanel />;
}
