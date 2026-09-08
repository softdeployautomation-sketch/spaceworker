import Link from "next/link";

import { DesktopClock } from "@/components/clock";
import { DashboardNav } from "@/components/dashboard-nav";
import { DesktopBackground } from "@/components/desktop-background";
import { Dock } from "@/components/dock";
import { LogoutButton } from "@/components/logout-button";
import { MenuBar } from "@/components/menu-bar";
import { ThemeToggle } from "@/components/theme-toggle";

interface ShellProps {
  children: React.ReactNode;
}

export function Shell({ children }: ShellProps) {
  return (
    <div className="relative min-h-screen">
      {/* Static 3D ambient desktop scene, behind everything else. */}
      <DesktopBackground />

      {/* OS menu bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-8 items-center justify-between border-b border-border bg-bg/90 px-3 backdrop-blur md:px-4">
        <div className="flex items-center gap-4">
          {/* Traffic-light window controls — decorative, matching a real
              desktop OS's window chrome (this "window" is the whole app). */}
          <div className="hidden items-center gap-[6px] md:flex" aria-hidden="true">
            <span className="h-[11px] w-[11px] rounded-full bg-[#ef4444]/70" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#eab308]/70" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#22c55e]/70" />
          </div>
          <Link href="/dashboard" className="flex items-center gap-2">
            <LogoMark />
            <span className="font-display text-[12.5px] font-bold text-fg">
              SpaceWorker OS
            </span>
          </Link>
          <MenuBar />
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <DesktopClock />
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>

      {/* Scrollable content viewport, cleared for the menu bar + dock. */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-8 pt-14 md:pb-32">
        {/* Inline nav row on small screens (the dock is the desktop nav). */}
        <div className="md:hidden">
          <div className="flex overflow-x-auto rounded-xl border border-border bg-bg-elevated/70 px-2 py-2 backdrop-blur">
            <DashboardNav variant="mobile" />
          </div>
        </div>

        <main className="md:mt-6">{children}</main>
      </div>

      {/* Application dock (desktop nav). */}
      <Dock />
    </div>
  );
}

function LogoMark() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#eaa53d" />
    </svg>
  );
}
