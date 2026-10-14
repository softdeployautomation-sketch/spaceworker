import type { Metadata } from "next";

import { CyberLabOpsConsole } from "@/components/cyberlab-ops-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Cyber Lab — Operation Console — SpaceWorker OS" };

// TASK_156B UI-1 (PLAN_CYBERLAB_STANDALONE_UI.md §3 "its own section", owner
// gate 1 approved) — /cyberlab is a TOP-LEVEL route OUTSIDE app/dashboard/*,
// so the <Shell> menubar + dock never render: entering it feels like a
// different place (same pattern as /console/[deviceId] and /clone/[cloneId]).
//
// Session gate: the proxy matcher passes non-/dashboard, non-/admin paths
// straight through (proxy.ts:242 — NextResponse.next()), so like the console
// route this page gates itself with getSession() and renders nothing without a
// valid customer session. The REAL entitlement/consent/tool gate still lives
// server-side on every /api/cyberlab/* call (the panel/status + runs routes);
// this is only the UX entry lock.
export default async function CyberLabSectionPage() {
  const session = await getSession();
  if (!session) return null;
  return <CyberLabOpsConsole />;
}
