"use client";

import Link from "next/link";

import { useNavItems } from "@/components/dashboard-nav";

// One-line descriptions shown under each app tile on the overview. New
// destinations will only show up here if they already appear in the nav data
// (useNavItems), so the overview can't drift from the real nav.
const DESCRIPTIONS: Record<string, string> = {
  Extract: "Search the web for leads and pull them into your workspace.",
  Mailboxes: "Connect your own SMTP accounts, tested before first use.",
  Campaigns: "Draft outreach and send safely under a daily cap.",
  "Browser Profiles": "Isolated Chrome profiles with clean fingerprints.",
  "Private Browser": "A real Chrome instance routed through a proxy.",
  Settings: "Account, billing, and workspace preferences.",
};

export default function DashboardPage() {
  const items = useNavItems();
  const overviewItems = items.filter(
    (i) =>
      i.href === "/dashboard/mailboxes" ||
      i.href === "/dashboard/campaigns" ||
      i.href === "/dashboard/extract" ||
      i.href === "/dashboard/browser-profiles" ||
      i.href === "/dashboard/browser" ||
      i.href === "/dashboard/settings",
  );

  return (
    <div className="space-y-6">
      {/* Welcome window */}
      <section className="relative overflow-hidden rounded-2xl border border-[#29314a] bg-gradient-to-br from-[#111a2e] to-[#0d1220] p-6 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.7)] sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand-600/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-indigo-900/30 blur-3xl"
        />
        <div className="relative">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Welcome back to SpaceWorker
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[#9ca3af] sm:text-[15px]">
            Your automation desktop. Find leads, keep your identity clean, and
            send outreach — all from one place.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              href="/dashboard/browser"
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-400"
            >
              Launch a browser
            </Link>
            <Link
              href="/dashboard/extract"
              className="rounded-lg border border-[#29314a] bg-[#0d1320]/60 px-4 py-2 text-sm font-medium text-[#c3c9d6] transition-colors hover:bg-white/5"
            >
              Extract leads
            </Link>
          </div>
        </div>
      </section>

      {/* App grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {overviewItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group rounded-xl border border-[#252e45] bg-[#0f1420]/80 p-5 shadow-sm backdrop-blur transition-colors hover:border-[#3b4668] hover:bg-[#121a2b]"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-[#29314a] bg-gradient-to-b from-[#1c2333] to-[#161b26]">
              <item.icon
                className="h-[20px] w-[20px] text-[#a5b4fc]"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </div>
            <h2 className="mt-4 text-[15px] font-semibold text-white">
              {item.label}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[#98a0b3]">
              {DESCRIPTIONS[item.label] ?? "Open this tool."}
            </p>
            <span className="mt-3 inline-block text-[12.5px] font-medium text-[#818cf8] opacity-0 transition-opacity group-hover:opacity-100">
              Open app →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}