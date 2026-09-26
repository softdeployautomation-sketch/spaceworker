"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useToast } from "@/components/toast";

// TASK_126 (2026-09-26) — this used to also render a sidebar + mobile nav
// strip with a single "Overview" link (from Task 1, when the whole admin
// panel WAS one page). AdminPanel has had its own real tab bar for a long
// time now, so that outer nav was just a second, redundant "Overview" sitting
// beside the real one — removed. This shell now only owns the page chrome
// every admin route shares: the top header and Log out.
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      const res = await fetch("/api/admin/logout", { method: "POST" });
      if (!res.ok) toast.push("Couldn't log out — try again.", "error");
    } catch {
      toast.push("Network error while logging out.", "error");
    } finally {
      setLoggingOut(false);
    }
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border bg-bg-elevated/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-lg font-bold text-brand-600 dark:text-brand-400">
              SpaceWorker · Admin
            </Link>
          </div>
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="rounded-lg px-3 py-2 text-sm font-medium text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}