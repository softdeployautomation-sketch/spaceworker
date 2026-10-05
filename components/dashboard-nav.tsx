"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Cloud,
  CreditCard,
  FlaskConical,
  Globe,
  LayoutDashboard,
  Megaphone,
  Monitor,
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
// TASK_100 MK5 (owner, 2026-09-22) — Advanced Search and Licenses removed from
// the nav: Advanced Search is a tab inside Extract (its old standalone page
// now just redirects there — app/dashboard/advanced-search/page.tsx), and
// Licenses is now a section inside Settings (app/dashboard/settings/licenses-section.tsx;
// /dashboard/licenses redirects there for a full session). Both old URLs keep
// working — only the nav entries are gone.
const NAV_ITEMS: Omit<NavItem, "active">[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  // Task 92 — devices placeholder (grid/detail arrive with Task 95). Web-only:
  // the extractor build's BUILD_ALLOWED_HREFS set below already excludes it.
  { href: "/dashboard/devices", label: "Devices", icon: Monitor },
  { href: "/dashboard/extract", label: "Extract", icon: Search },
  { href: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/dashboard/automations", label: "Automations", icon: Zap },
  { href: "/dashboard/browser", label: "Private Browser", icon: Globe },
  // TASK_155 P1 — hosting (files / pages / links). Web-only, so it is absent
  // from the extractor build's BUILD_ALLOWED_HREFS set below (auto-excluded).
  { href: "/dashboard/hosting", label: "Hosting", icon: Cloud },
  // TASK_156 (Cyber Lab) — nav entry + dashboard card land NOW (owner,
  // 2026-10-01: "the cyberlab and workers should be added to the menu and
  // dashboard cards"), but the engine itself is C1/C2 work. The page is a dark
  // "not available yet" placeholder until AdminSetting.cyberlabEnabled is on and
  // the lab ships, exactly like Hosting was before P1 was switched on.
  { href: "/dashboard/cyberlab", label: "Cyber Lab", icon: FlaskConical },
  // TASK_161 D3 / Task 158 W2 — Billing was LIVE but UNREACHABLE: /dashboard/billing
  // existed and rendered the wallet balance card, yet no NAV_ITEMS entry pointed at
  // it, so there was no way to click to it from the dock or the mobile nav row. The
  // owner reported "I see no billing page or tab right now", and that was correct.
  // Web-only, so it is auto-excluded from the extractor build below.
  //
  // KNOWN SEPARATE DEFECT, deliberately NOT fixed here (it is its own change and
  // would not belong in a Billing-visibility commit): `Mailboxes` has a DESCRIPTIONS
  // entry but STILL has no NAV_ITEMS entry, so /dashboard/mailboxes is unreachable
  // from the OS chrome for the same reason. See SENIOR_HANDOFF §7.2.
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

// Build-target nav narrowing (Task 27 Part A "four build targets, one core"): the
// Extractor EXE ships the Extract page only — Campaigns/Automations/Browser are
// excluded. The web app passes no build target and sees the full nav. Keys are the
// exact ExeBuildTarget values from lib/exe-build-target.ts.
const BUILD_ALLOWED_HREFS: Record<string, Set<string> | undefined> = {
  extractor: new Set(["/dashboard", "/dashboard/extract", "/dashboard/settings"]),
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