"use client";

import { useEffect } from "react";

// Catches any uncaught render error in a page/segment below the root layout
// (Next.js App Router convention — errors thrown BY the root layout itself
// still need app/global-error.tsx). Reports to the server (see
// app/api/client-error-report/route.ts) so a crash is visible in the
// deployed box's logs immediately, instead of only via a user's screenshot.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    fetch("/api/client-error-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof window !== "undefined" ? window.location.href : undefined,
      }),
    }).catch(() => {
      // Best-effort — never let the reporting call itself compound the crash.
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold text-fg">Something went wrong</h1>
      <p className="max-w-md text-sm text-fg-muted">
        This page hit an unexpected error. It&apos;s been reported — try reloading, or go back.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Try again
      </button>
    </div>
  );
}
