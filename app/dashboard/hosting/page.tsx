import type { Metadata } from "next";

import { HostingPanel } from "@/components/hosting-panel";

export const metadata: Metadata = { title: "Hosting — SpaceWorker OS" };

// TASK_155 P1 — the Hosting tab. Client-rendered against /api/hosting/* so the
// page needs no server data at build time (and stays out of the EXE bundles).
export default function HostingPage() {
  return <HostingPanel />;
}
