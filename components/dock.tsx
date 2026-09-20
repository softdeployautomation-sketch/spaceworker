"use client";

import Link from "next/link";

import { useNavItems, type NavItem } from "@/components/dashboard-nav";
import { cn } from "@/lib/cn";

export function Dock({ buildTarget }: { buildTarget?: string }) {
  const items = useNavItems(buildTarget);

  // Settings sits in its own dock group, separated by a divider — matching the
  // Desktop.design.html artboard (app icons, then a separator, then Settings).
  const primary = items.slice(0, -1);
  const settings = items[items.length - 1];

  return (
    <nav
      aria-label="Dock"
      className="fixed bottom-4 left-1/2 z-30 hidden -translate-x-1/2 items-end gap-2 rounded-[20px] border border-border bg-bg-elevated/60 px-3 py-2 shadow-[0_24px_60px_-18px_rgba(0,0,0,0.15)] backdrop-blur-xl dark:shadow-[0_24px_60px_-18px_rgba(0,0,0,0.8)] md:flex"
    >
      <div className="flex items-end gap-1">
        {primary.map((item) => (
          <DockIcon key={item.href} {...item} />
        ))}
      </div>
      <div aria-hidden className="mx-1 w-px self-stretch bg-border" />
      {settings && <DockIcon {...settings} />}
    </nav>
  );
}

function DockIcon({ href, label, icon: Icon, active }: NavItem) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="group relative flex flex-col items-center gap-1 rounded-2xl px-1 py-1"
    >
      {/* Hover tooltip — kept alongside the always-visible label below since
          the label alone truncates on the narrowest items ("Advanced
          Search"); confirmed live 2026-09-20 that icon-only (no visible
          label) was genuinely hard to tell apart at dock size — a user
          repeatedly couldn't identify which icon was which. */}
      <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-black/90 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        {label}
      </span>

      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-[13px] border bg-gradient-to-b from-white to-gray-50 shadow-[0_10px_24px_-10px_rgba(0,0,0,0.15)] transition-transform duration-150 ease-out group-hover:-translate-y-2 dark:from-bg-elevated dark:to-bg dark:shadow-[0_10px_24px_-10px_rgba(0,0,0,0.6)]",
          active
            ? "border-brand-600/70 ring-1 ring-brand-400/40"
            : "border-gray-200/70 dark:border-border/70",
        )}
      >
        <Icon
          className={cn(
            "h-[22px] w-[22px] transition-colors",
            active
              ? "text-brand-600 dark:text-brand-300"
              : "text-gray-500 group-hover:text-brand-600 dark:text-fg-muted dark:group-hover:text-brand-300",
          )}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </span>

      <span
        className={cn(
          "max-w-[52px] truncate text-center text-[9px] font-medium leading-tight transition-colors",
          active ? "text-brand-600 dark:text-brand-300" : "text-fg-muted",
        )}
        aria-hidden="true"
      >
        {label}
      </span>
    </Link>
  );
}