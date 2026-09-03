"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Fingerprint,
  Globe,
  LayoutDashboard,
  Mailbox,
  Megaphone,
  Settings,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}

export function DashboardNav({
  variant = "sidebar",
}: {
  variant?: "sidebar" | "mobile";
}) {
  const pathname = usePathname();

  const items: NavItem[] = [
    {
      href: "/dashboard",
      label: "Overview",
      icon: LayoutDashboard,
      active: pathname === "/dashboard",
    },
    {
      href: "/dashboard/mailboxes",
      label: "Mailboxes",
      icon: Mailbox,
      active: pathname.startsWith("/dashboard/mailboxes"),
    },
    {
      href: "/dashboard/campaigns",
      label: "Campaigns",
      icon: Megaphone,
      active: pathname.startsWith("/dashboard/campaigns"),
    },
    {
      href: "/dashboard/browser-profiles",
      label: "Browser Profiles",
      icon: Fingerprint,
      active: pathname.startsWith("/dashboard/browser-profiles"),
    },
    {
      href: "/dashboard/browser",
      label: "Private Browser",
      icon: Globe,
      active: pathname.startsWith("/dashboard/browser"),
    },
    {
      href: "/dashboard/settings",
      label: "Settings",
      icon: Settings,
      active: pathname.startsWith("/dashboard/settings"),
    },
  ];

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