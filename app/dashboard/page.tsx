"use client";

import Link from "next/link";

import { useNavItems } from "@/components/dashboard-nav";
import { cn } from "@/lib/cn";

// One-line descriptions shown under each app tile on the overview. New
// destinations will only show up here if they already appear in the nav data
// (useNavItems), so the overview can't drift from the real nav.
const DESCRIPTIONS: Record<string, string> = {
  Extract: "Search the web for leads and pull them into your workspace.",
  Mailboxes: "Connect your own SMTP accounts, tested before first use.",
  Campaigns: "Draft outreach and send safely under a daily cap.",
  Automations: "Save a re-runnable extract + send config, or ask the agent to plan one for you.",
  "Private Browser": "A real Chrome instance routed through a proxy, with isolated profiles under the Browser Profiles tab.",
  Settings: "Account, billing, and workspace preferences.",
};

export default function DashboardPage() {
  const items = useNavItems();
  const overviewItems = items.filter(
    (i) =>
      i.href === "/dashboard/mailboxes" ||
      i.href === "/dashboard/campaigns" ||
      i.href === "/dashboard/automations" ||
      i.href === "/dashboard/extract" ||
      i.href === "/dashboard/browser" ||
      i.href === "/dashboard/settings",
  );
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
    <div className="space-y-6">
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

      {/* App grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {overviewItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group rounded-xl border border-border bg-bg-elevated p-5 shadow-sm backdrop-blur transition-colors hover:border-brand-500/70 hover:bg-bg"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-border bg-bg">
              <item.icon
                className="h-[20px] w-[20px] text-brand-600 dark:text-brand-300"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </div>
            <h2 className="mt-4 font-display text-[15px] font-semibold text-fg">
              {item.label}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              {DESCRIPTIONS[item.label] ?? "Open this tool."}
            </p>
            <span className="mt-3 inline-block text-[12.5px] font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-brand-400">
              Open app →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}