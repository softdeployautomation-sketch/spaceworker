import type { Metadata } from "next";

import { DeviceList } from "@/components/device-list";

export const metadata: Metadata = { title: "Devices — SpaceWorker OS" };

// Task 95 — Devices v2. The list is client-rendered (live sync from Vantra on
// load); the console pages carry the tools.
export default function DevicesPage() {
  return <DeviceList />;
}
