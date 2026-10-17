import type { Metadata } from "next";

import { CloneSessionView } from "@/components/clone-session-view";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Cloned browser — SpaceWorker OS" };

// TASK_216 D1 — session-gated server page (a baked gate bounces/blanks users
// the same way it baked /cyberlab's 307 — see that page's comment).
export const dynamic = "force-dynamic";

// Task 111 (bit B5) — the chrome-free clone session window. Top-level route
// (OUTSIDE app/dashboard/*, so the <Shell> menubar + dock never render): just
// the hosted browser plus its own thin toolbar. Opens in a new tab; closing
// it never kills the session — Revoke does.
export default async function CloneSessionPage({
  params,
}: {
  params: Promise<{ cloneId: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  const { cloneId } = await params;
  return <CloneSessionView cloneId={cloneId} />;
}
