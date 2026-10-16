import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CyberLabOpsConsole } from "@/components/cyberlab-ops-console";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Cyber Lab — Operation Console — SpaceWorker OS" };

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
