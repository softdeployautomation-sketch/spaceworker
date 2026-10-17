import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CyberLabOpsConsole } from "@/components/cyberlab-ops-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Cyber Lab — Operation Console — SpaceWorker OS" };

// TASK_216 D1 — session-gated server page: NEVER statically prerender. During
// `next build` this component executed with an empty cookie store, so
// getSession() returned null and the redirect() below fired AT BUILD TIME —
// Next baked a static 307 → / into the prerender artifact (cyberlab.{html,rsc,
// meta} carried `x-nextjs-prerender: 1`) and served it to EVERY request,
// including authed users. Owner incident 2026-10-16: clicking "Open the
// Operation Console ↗" bounced to the marketing /home page while logged in.
// force-dynamic makes the gate evaluate per request, like it always should
// have. See tests/task-216-force-dynamic.test.ts for the class-wide pin.
export const dynamic = "force-dynamic";

// TASK_156B UI-1 — /cyberlab is a TOP-LEVEL route OUTSIDE app/dashboard/*, so the
// <Shell> menubar + dock never render: entering it feels like a different place.
//
// This is an APP FEATURE (the operation console for authed customers), NOT a
// marketing tab — so it must NOT join the subtab → /home redirects. The hidden-
// login bounce applies here only to unauthenticated visitors: they are sent to the
// public joker page at `/`, while a valid session renders the console. The REAL
// entitlement/consent/tool gate still lives server-side on every /api/cyberlab/*
// call; this is only the UX entry lock.
export default async function CyberLabSectionPage() {
  const session = await getSession();
  if (!session) redirect("/"); // hidden-login: unauth → public clown page
  return <CyberLabOpsConsole />;
}
