"use client";

import Link from "next/link";

import { useNavItems } from "@/components/dashboard-nav";
import { OverviewStatsRow } from "@/components/overview-stats-row";
import { cn } from "@/lib/cn";

// PLAN_TASK_165 P2 (owner, 2026-10-05) — the overview becomes a launcher rather
// than a card gallery. Two changes, one concern (the overview page itself):
//
// 1. The overview CARDS ARE GONE. The owner asked for this explicitly: every app
//    is already reachable from the dock below, so the grid was duplication. With
//    the cards gone the DESCRIPTIONS map has no consumer and is deleted with them.
//
// 2. THE SIDE NAV IS GONE TOO — owner reversal, 2026-10-05, screenshot-verified.
//    P2 originally rendered `DashboardNav variant="sidebar"` here. It looked
//    correct in the markup but on screen it was a literal second copy of the
//    bottom dock: every app listed twice, in the same order, in one viewport.
//    The dock (`components/dock.tsx`) is the app launcher and already does this
//    job better (it is always visible, not overview-only). Two navs rendering the
//    same nine hrefs from the same `useNavItems()` is duplication, not a design.
//    Nothing else had to change: `DashboardNav` keeps its `variant="sidebar"`
//    prop (it is dead-but-harmless, and `variant="mobile"` is still live in
//    `shell.tsx`), so this is a small, revertible deletion.
//
// THE DEAD FILTER IS DELETED, NOT PATCHED — that part of P2 STANDS. It read
//   items.filter(i => i.href === "/dashboard/devices" || ... || i.href === "/dashboard/mailboxes" || ...)
// an allow-list containing i.href === "/dashboard/mailboxes" — a condition that
// can never be true, because no nav item has that href (mailboxes are a tab inside
// Campaigns; app/dashboard/mailboxes/page.tsx is a redirect to ?tab=mailboxes).
// So it looked maintained while silently dropping every newly added app, which is
// exactly how Billing shipped reachable-but-invisible. Deleting the allow-list IS
// the fix and it must not come back.
//
// LAYOUT (owner, 2026-10-05): the hero is now a single full-width welcome window
// pinned near the top, and everything below it is left deliberately EMPTY. That
// space is the reserved stage for the wallpaper / 3D centrepiece (PLAN_TASK_165
// P3, D6): a robot running around a globe has to be visible against the desktop
// background, and a full-height card grid left nowhere to show it. `useNavItems()`
// is still called — not for rendering a second nav, but because the two hero
// buttons below are gated on the destination being present in THIS build's nav,
// which is what stops "Launch a browser" throwing inside the Extractor EXE.

export default function DashboardPage() {
  // Same no-arg call as before: useNavItems() falls back to the EXE build target
  // from context, which keeps the Extractor build's sidebar narrowed to
  // Overview/Extract/Settings instead of leaking the full web nav into the EXE.
  const items = useNavItems();
  // Confirmed live (2026-09-19) — the sidebar nav (dashboard-nav.tsx's
  // BUILD_ALLOWED_HREFS) already narrows to Extract-only for the Extractor
  // build, but these two hero buttons were hardcoded regardless of build
  // target: "Launch a browser" threw an internal error inside the Extractor
  // EXE (its /dashboard/browser page needs the real database + VPS browser-
  // session infrastructure, neither of which exist there — it isn't a "needs
  // the hosted app" redirect case like auth, it's a page this build was never
  // meant to ship at all). Only show a hero button when its destination is
  // actually in this build's nav.
  const hasBrowser = items.some((i) => i.href === "/dashboard/browser");
  const hasExtract = items.some((i) => i.href === "/dashboard/extract");

  return (
    <div className="space-y-4">
      {/* Welcome window — a deliberately dark "featured" panel regardless of
          the app's own light/dark setting, same as a real OS's spotlight
          card; every other surface below is theme-aware.

          Pinned to the top of the viewport (owner, 2026-10-05) so the rest of
          the screen is free for the wallpaper / 3D centrepiece.

          HERO HEIGHT IS CONTENT-SIZED, NOT RESERVED (owner, 2026-10-05, after
          screenshot review). This section previously carried `min-h-[46vh]`
          "to give the empty stage below a real height" — but the screenshot
          showed that only padded the hero: the buttons ended ~490px down a
          mostly-empty card, the status row sat well below the fold, and the
          space it bought was unreachable anyway because the real stage is the
          viewport the wallpaper renders into. The reserved height now belongs
          to the stage div below, and the hero shrinks to wrap its content so
          the status row sits directly under the buttons. DO NOT reintroduce a
          min-h here: the brief is "one-liner stats immediately under the hero,
          everything below is wallpaper". Keep it content-height and compact. */}
      <section className="relative overflow-hidden rounded-2xl border border-[#352a1e] bg-gradient-to-br from-[#241c14] to-[#17130f] p-5 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.7)] sm:p-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand-500/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-brand-900/30 blur-3xl"
        />
        <div className="relative">
          <h1 className="font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
            Welcome back to SpaceWorker OS
          </h1>
          <p className="mt-1.5 max-w-xl text-[13px] text-[#ab9a86] sm:text-sm">
            Your automation desktop. Find leads, keep your identity clean, and
            send outreach — all from one place.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            {hasBrowser && (
              <Link
                href="/dashboard/browser"
                className="rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-brand-400"
              >
                Launch a browser
              </Link>
            )}
            {hasExtract && (
              <Link
                href="/dashboard/extract"
                className={cn(
                  "rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                  hasBrowser
                    ? "border border-[#352a1e] bg-[#17130f]/60 text-[#e5d9c6] hover:bg-white/5"
                    : "bg-brand-500 text-white font-semibold hover:bg-brand-400",
                )}
              >
                Extract leads
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* STATUS ROW (owner, 2026-10-05: "wallet balance, AI balance and used, and
          other dashboard in one line under the hero"). One component, one fetch,
          so the numbers arrive together instead of reflowing the row one tile at
          a time. It renders NOTHING rather than zeroes if the read fails. */}
      <OverviewStatsRow />

      {/* RESERVED STAGE — PLAN_TASK_165 P3 (D5 wallpaper / D6 3D centrepiece)
          renders here. Intentionally empty in this commit: the hero and the
          status row sit at the top, and this gap is where the globe scene goes
          so it is not hidden behind a card grid or a second nav. Do not fill it
          with cards — that is what was just removed. */}
      <div aria-hidden className="min-h-[55vh]" />
    </div>
  );
}