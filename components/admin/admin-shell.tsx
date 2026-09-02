"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { useToast } from "@/components/toast";
import { cn } from "@/lib/cn";

// Grows in Task 3/4/5 (queue/lanes, billing, users). Task 1 has just the
// overview shell so the passcode gate is reachable and testable now.
const NAV_ITEMS = [{ href: "/admin", label: "Overview" }];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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

      <div className="mx-auto flex max-w-6xl">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-48 shrink-0 flex-col border-r border-border px-3 py-6 md:flex">
          <nav className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  pathname === item.href || pathname.startsWith(item.href + "/")
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                    : "text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="px-4 pt-4 md:hidden">
            <div className="flex overflow-x-auto rounded-lg border border-border bg-bg-elevated px-2 py-2">
              <nav className="flex flex-row gap-1">
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      pathname === item.href
                        ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                        : "text-fg-muted hover:bg-black/5 hover:text-fg dark:hover:bg-white/5",
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </div>
          <main className="px-4 py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}