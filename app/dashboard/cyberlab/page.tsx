import type { Metadata } from "next";

import { CyberLabPanel } from "@/components/cyberlab-panel";

export const metadata: Metadata = { title: "Cyber Lab — SpaceWorker OS" };

// TASK_156 C1 (scaffolding) — the Cyber Lab tab. Client-rendered against
// /api/cyberlab/status so the page needs no server data at build time (and stays
// out of the EXE bundles). The engine itself is C1/C2 work; this ships the nav
// entry, the dashboard card and an honest "not available yet" surface.
export default function CyberLabPage() {
  return <CyberLabPanel />;
}
