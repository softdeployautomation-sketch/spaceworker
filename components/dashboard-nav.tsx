"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Globe,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  Search,
  Settings,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { useBuildTarget } from "@/components/build-target-context";
import { cn } from "@/lib/cn";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}

// Single source of truth for every real nav destination. Both the dock and the
// inline mobile nav row render from here so the two can never drift from each
// other (or from the destinations each dashboard page actually implements).
const NAV_ITEMS: Omit<NavItem, "active">[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/extract", label: "Extract", icon: Search },
  { href: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/dashboard/automations", label: "Automations", icon: Zap },
  { href: "/dashboard/browser", label: "Private Browser", icon: Globe },
  { href: "/dashboard/licenses", label: "Licenses", icon: KeyRound },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

// Build-target nav narrowing (Task 27 Part A "four build targets, one core"): the
// Extractor EXE ships the Extract page only — Campaigns/Automations/Browser are
// excluded. The web app passes no build target and sees the full nav. Keys are the
// exact ExeBuildTarget values from lib/exe-build-target.ts.
const BUILD_ALLOWED_HREFS: Record<string, Set<string> | undefined> = {
  extractor: new Set([
    "/dashboard",
    "/dashboard/extract",
    "/dashboard/licenses",
    "/dashboard/settings",
  ]),
};

export function useNavItems(buildTargetArg?: string): NavItem[] {
  const pathname = usePathname();
  // Explicit arg wins; otherwise fall back to the EXE build target provided by the
  // dashboard layout's context. This is the safety net that stops a consumer that
  // forgets to thread buildTarget from leaking the full web nav into an EXE build.
  const contextTarget = useBuildTarget();
  const buildTarget = buildTargetArg ?? contextTarget;
  const allowed = buildTarget ? BUILD_ALLOWED_HREFS[buildTarget] : undefined;
  return NAV_ITEMS
    .filter((item) => !allowed || allowed.has(item.href))
    .map((item) => ({
      ...item,
      active:
        item.href === "/dashboard"
          ? pathname === "/dashboard"
          : pathname.startsWith(item.href),
    }));
}

export function DashboardNav({
  variant = "sidebar",
  buildTarget,
}: {
  variant?: "sidebar" | "mobile";
  buildTarget?: string;
}) {
  const items = useNavItems(buildTarget);

  const isMobile = variant === "mobile";

  return (
    <nav
      className={cn(
        "flex gap-1",
        isMobile ? "flex-row items-center" : "flex-col",
      )}
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            isMobile && "shrink-0 whitespace-nowrap",
            item.active
              ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
              : "text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
          )}
        >
          <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}