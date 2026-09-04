"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Fingerprint,
  Globe,
  LayoutDashboard,
  Mailbox,
  Megaphone,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";

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
  { href: "/dashboard/mailboxes", label: "Mailboxes", icon: Mailbox },
  { href: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone },
  {
    href: "/dashboard/browser-profiles",
    label: "Browser Profiles",
    icon: Fingerprint,
  },
  { href: "/dashboard/browser", label: "Private Browser", icon: Globe },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function useNavItems(): NavItem[] {
  const pathname = usePathname();
  return NAV_ITEMS.map((item) => ({
    ...item,
    active:
      item.href === "/dashboard"
        ? pathname === "/dashboard"
        : pathname.startsWith(item.href),
  }));
}

export function DashboardNav({
  variant = "sidebar",
}: {
  variant?: "sidebar" | "mobile";
}) {
  const items = useNavItems();

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