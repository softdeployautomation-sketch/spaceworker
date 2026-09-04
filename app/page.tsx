import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "SpaceWorker" };

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-16 text-center">
      <h1 className="text-4xl font-bold text-fg">SpaceWorker</h1>
      <p className="mt-3 max-w-md text-fg-muted">
        A private browser workspace — your own persistent, streamed browser
        running on lightweight infrastructure, with automation riding alongside
        it. Research, extract, and follow up in one place.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
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

      <div className="mt-12 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Capabilities
        </p>
        <ul className="mt-4 grid gap-3 text-left sm:grid-cols-2">
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-fg-muted">
            <span className="font-semibold text-fg">Private browser</span> — a
            real, persistent browser you can drive from your dashboard, with a
            sticky IP that isn&apos;t linkable to your real network.
          </li>
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-fg-muted">
            <span className="font-semibold text-fg">Lead extraction</span> — run
            searches and collect businesses &amp; contact detail into a clean,
            exportable lead list.
          </li>
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-fg-muted">
            <span className="font-semibold text-fg">Outreach</span> — campaign
            mailings with subject &amp; sender rotation, test-send confirmation,
            and per-recipient variables.
          </li>
          <li className="rounded-xl border border-border bg-card p-4 text-sm text-fg-muted">
            <span className="font-semibold text-fg">Browser profiles</span> —
            per-user profiles that keep your browsing context and fingerprints
            separate and persistent.
          </li>
        </ul>
      </div>
    </div>
  );
}