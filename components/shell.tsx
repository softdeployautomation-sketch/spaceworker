import Link from "next/link";

import { AgentWidget } from "@/components/agent-widget";
import { AgentPageContextProvider } from "@/lib/agent-page-context";
import { DesktopClock } from "@/components/clock";
import { DashboardNav } from "@/components/dashboard-nav";
import { DesktopBackground } from "@/components/desktop-background";
import { Dock } from "@/components/dock";
import { LogoutButton } from "@/components/logout-button";
import { MenuBar } from "@/components/menu-bar";
import { SupportWidget } from "@/components/support-widget";
import { ThemeToggle } from "@/components/theme-toggle";
import { WalletChip } from "@/components/wallet-chip";

interface ShellProps {
  children: React.ReactNode;
  /** Desktop EXE build target (e.g. "extractor") narrows the nav; the web app omits it. */
  buildTarget?: string;
}

export function Shell({ children, buildTarget }: ShellProps) {
  return (
    <AgentPageContextProvider>
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
          <MenuBar buildTarget={buildTarget} />
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          {/* PLAN_TASK_165 P1 — the Wallet chip, beside the date. Web-hosted only,
              for the same reason as the widgets below: GET /api/wallet is a real
              Prisma-backed route and the EXE ships with no DATABASE_URL. The chip
              also hides itself for a 403, which is what a `license_only` session
              gets from proxy.ts. */}
          {!buildTarget && <WalletChip />}
          <DesktopClock />
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {!buildTarget && <LogoutButton />}
          </div>
        </div>
      </header>

      {/* Scrollable content viewport, cleared for the menu bar + dock. */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-8 pt-14 md:pb-32">
        {/* Inline nav row on small screens (the dock is the desktop nav). */}
        <div className="md:hidden">
          <div className="flex overflow-x-auto rounded-xl border border-border bg-bg-elevated/70 px-2 py-2 backdrop-blur">
            <DashboardNav variant="mobile" buildTarget={buildTarget} />
          </div>
        </div>

        <main className="md:mt-6">{children}</main>
      </div>

      {/* Application dock (desktop nav). */}
      <Dock buildTarget={buildTarget} />

      {/* 2026-09-27 — the floating agent widget. Web-hosted only: the EXE
          runtime (buildTarget set) has no DATABASE_URL, and /api/agent is a
          real Prisma-backed route — it would just fail there. */}
      {!buildTarget && <AgentWidget />}

      {/* TASK_161 D3 — the support widget, for the same reason and with the same
          gate: /api/support/** is a real Prisma-backed route and the EXE ships
          with no DATABASE_URL.

          Placed BOTTOM-LEFT, not bottom-right, because AgentWidget already owns
          bottom-right (components/agent-widget.tsx). Two widgets on the same
          corner overlap each other, and the one underneath becomes unclickable —
          which would make support unreachable in exactly the width range where
          the panel is open. Opposite corners is the fix, and it is a positional
          decision rather than an arbitrary one. */}
      {!buildTarget && <SupportWidget />}
      </div>
    </AgentPageContextProvider>
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
