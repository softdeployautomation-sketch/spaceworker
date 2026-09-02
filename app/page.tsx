import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Home" };

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 text-center">
      <h1 className="text-4xl font-bold text-fg">SpaceWorker</h1>
      <p className="mt-3 max-w-md text-fg-muted">
        Automation tools for lead extraction, filtering, and email outreach.
        Sign up to get started.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/signup"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Create account
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-border bg-bg-elevated px-4 py-2 text-sm font-semibold text-fg hover:bg-black/5 dark:hover:bg-white/5"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}