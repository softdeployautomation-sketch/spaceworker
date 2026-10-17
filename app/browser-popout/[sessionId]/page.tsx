import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { BrowserPopoutView } from "@/components/browser-popout-view";
import { getSession } from "@/lib/auth";
import { isSameOriginConnectUrl } from "@/lib/browser-popout";
import { SESSION_SAFE_SELECT } from "@/lib/browser-session-safe-select";
import { connectUrlFor } from "@/lib/browser-session-serialize";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Private browser — SpaceWorker OS" };

// TASK_216 D1 — session-gated + redirect: force per-request rendering so the
// gate can never bake into the build artifact (see app/cyberlab/page.tsx).
export const dynamic = "force-dynamic";

// Mirrors connectUrlFor's own base (lib/browser-session-serialize.ts) so the
// guard below checks the SAME value the URL was minted from — deliberately not
// lib/env's hard required() so importing this module can never throw at build.
const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3400";

// TASK_212 D3 — the pop-out wrapper tab. Instead of `window.open`-ing the raw
// Neko URL (which carries no SpaceWorker chrome: no mouse controller, no
// keyboard bar — the owner's report), the panel opens THIS route, which
// re-mints the connectUrl server-side after auth + ownership checks and
// renders the shared controller around the stream (BrowserPopoutView).
//
// Why a route and not a ?url= param (design decision, TASK_212 STEPS §3 D3):
// connectUrl embeds Neko's auto-login credentials (usr/pwd). A query param
// would leak them into browser history, Referer headers and server logs; here
// they never appear in anything the client provides or can read back — the
// iframe src is built from the DB row, like the dashboard embed already does
// via serializeSession (same safe-select, same ownership scoping).
export default async function BrowserPopoutPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { sessionId } = await params; // MUST await — async in Next.js 16

  // Ownership-scoped exactly like GET /api/browser-sessions/[id]: another
  // user's session id yields the standard 404, never a probe-able difference.
  const row = await prisma.browserSession.findFirst({
    where: { id: sessionId, userId: session.sub },
    select: SESSION_SAFE_SELECT,
  });
  if (!row) notFound();

  // Session stopped between the panel's click and this render (or the tab was
  // left open past its lifetime): a friendly dead-end instead of a broken
  // stream. The user closes the tab and goes back to the dashboard — no
  // auto-reconnect, since a new session would be a different row/id anyway.
  if (row.status !== "running") {
    return (
      <main className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-black px-6 text-center">
        <p className="text-sm text-zinc-400">
          This private browser session has ended &mdash; the stream and the
          mouse &amp; keyboard controls are only available while it runs.
          Close this tab and start a new session from the dashboard.
        </p>
        <a
          href="/dashboard/browser"
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
        >
          Back to Private browsers
        </a>
      </main>
    );
  }

  const connectUrl = connectUrlFor(row.id, row.nekoPassword);

  // Same-origin guard (TASK_208 gate precedent, lib/browser-popout.ts): the
  // whole control model (installTouchControls → __swKey/__swMouse injection)
  // only works while the frame is served through our own origin. The URL was
  // just minted from APP_BASE_URL so this is defense-in-depth — it turns a
  // future refactor that sources the src from anywhere else into a loud
  // refusal instead of a silent stream with dead controls.
  if (!isSameOriginConnectUrl(connectUrl, APP_BASE_URL)) {
    return (
      <main className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-black px-6 text-center">
        <p className="text-sm text-zinc-400">
          This session&apos;s stream can&apos;t be controlled from the pop-out
          tab right now. Close it and use &quot;Reconnect here instead&quot; on
          the dashboard.
        </p>
      </main>
    );
  }

  return <BrowserPopoutView connectUrl={connectUrl} />;
}
