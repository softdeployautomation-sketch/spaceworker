import Link from "next/link";

import { DesktopClock } from "@/components/clock";
import { DashboardNav } from "@/components/dashboard-nav";
import { DesktopBackground } from "@/components/desktop-background";
import { Dock } from "@/components/dock";
import { LogoutButton } from "@/components/logout-button";
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
      <header className="fixed inset-x-0 top-0 z-40 flex h-8 items-center justify-between border-b border-[#1c2333] bg-[#0b0f17]/90 px-3 backdrop-blur md:px-4">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="flex items-center gap-2">
            <LogoMark />
            <span className="text-[12.5px] font-bold text-[#f4f5f7]">
              SpaceWorker
            </span>
          </Link>
          <span className="hidden text-[12.5px] text-[#8b93a7] md:inline">
            File
          </span>
          <span className="hidden text-[12.5px] text-[#8b93a7] md:inline">
            Window
          </span>
          <span className="hidden text-[12.5px] text-[#8b93a7] md:inline">
            Help
          </span>
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
          <div className="flex overflow-x-auto rounded-xl border border-[#232a3b] bg-[#0d1320]/70 px-2 py-2 backdrop-blur">
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
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#818cf8" />
    </svg>
  );
}
