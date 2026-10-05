"use client";

import Link from "next/link";

import { DashboardNav, useNavItems } from "@/components/dashboard-nav";
import { cn } from "@/lib/cn";

// PLAN_TASK_165 P2 (owner, 2026-10-05) — the overview becomes a launcher rather
// than a card gallery. Two changes, one concern (the overview page itself):
//
// 1. The overview CARDS ARE GONE. The owner asked for this explicitly: every app
//    is already reachable from the dock below, so the grid was duplication. With
//    the cards gone the DESCRIPTIONS map has no consumer and is deleted with them.
//
// 2. A SIDE NAV replaces them, rendered HERE and only here. It is deliberately NOT
//    added to components/shell.tsx — that file wraps every dashboard page, so a
//    sidebar there would put a second nav on every screen, the opposite of "a
//    small side nav, visible only on the overview dashboard".
//
// THE DEAD FILTER IS DELETED, NOT PATCHED. It read
//   items.filter(i => i.href === "/dashboard/devices" || ... || i.href === "/dashboard/mailboxes" || ...)
// an allow-list containing i.href === "/dashboard/mailboxes" — a condition that
// can never be true, because no nav item has that href (mailboxes are a tab inside
// Campaigns; app/dashboard/mailboxes/page.tsx is a redirect to ?tab=mailboxes).
// So it looked maintained while silently dropping every newly added app, which is
// exactly how Billing shipped reachable-but-invisible. Deleting the allow-list IS
// the fix; the sidebar is driven straight from useNavItems(), the same single
// source the dock, the mobile row and the Window menu use, so it cannot drift.
//
// The `hidden md:block` on the aside is load-bearing: below md the dock is hidden
// and the inline mobile nav row in shell.tsx is the nav, so a visible sidebar there
// would give a phone two competing navs. With the cards removed, the sidebar IS the
// overview's app launcher, and on mobile the dock below carries it.

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
    <div className="md:flex md:items-start md:gap-6">
      {/* Overview-only side nav. Fixed width, so the welcome panel beside it keeps
          its own layout instead of being reflowed by each label's length. */}
      <aside
        aria-label="Overview navigation"
        className="hidden w-52 shrink-0 rounded-xl border border-border bg-bg-elevated/60 p-2 backdrop-blur md:block"
      >
        <DashboardNav variant="sidebar" />
      </aside>

      <div className="min-w-0 flex-1 space-y-6">
        {/* Welcome window — a deliberately dark "featured" panel regardless of
            the app's own light/dark setting, same as a real OS's spotlight
            card; every other surface below is theme-aware. */}
        <section className="relative overflow-hidden rounded-2xl border border-[#352a1e] bg-gradient-to-br from-[#241c14] to-[#17130f] p-6 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.7)] sm:p-8">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand-500/20 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-brand-900/30 blur-3xl"
          />
          <div className="relative">
            <h1 className="font-display text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Welcome back to SpaceWorker OS
            </h1>
            <p className="mt-2 max-w-xl text-sm text-[#ab9a86] sm:text-[15px]">
              Your automation desktop. Find leads, keep your identity clean, and
              send outreach — all from one place.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {hasBrowser && (
                <Link
                  href="/dashboard/browser"
                  className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-400"
                >
                  Launch a browser
                </Link>
              )}
              {hasExtract && (
                <Link
                  href="/dashboard/extract"
                  className={cn(
                    "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
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
      </div>
    </div>
  );
}