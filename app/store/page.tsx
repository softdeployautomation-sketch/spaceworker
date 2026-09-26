import type { Metadata } from "next";
import Link from "next/link";

import { Store } from "@/components/store";
import { accountHref } from "@/lib/exe-runtime";

// TASK_100 MK3 — the store moves off the marketing scroll onto its own,
// linkable/indexable route (nav: Features / Store / Pricing). Reuses
// components/store.tsx as-is, same pattern app/pricing/page.tsx already
// established for the identical component — this route is the primary
// "browse what you can buy" destination; /pricing keeps its own identity
// (platform-level framing) per MK4.
export const metadata: Metadata = { title: "Store — SpaceWorker OS" };

export default function StorePage() {
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-display font-bold text-fg">
            <LogoMark />
            <span>SpaceWorker OS</span>
          </Link>
          <nav className="hidden gap-5 text-sm font-medium text-fg-muted hover:text-fg md:flex">
            <Link href="/#features" className="hover:text-fg">Features</Link>
            <Link href="/store" className="hover:text-fg">Store</Link>
            <Link href="/pricing" className="hover:text-fg">Pricing</Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link href={accountHref("/login")} className="text-sm font-semibold text-fg-muted hover:text-fg">
              Sign in
            </Link>
            <Link href={accountHref("/signup")} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Store</p>
        <h1 className="mt-3 text-3xl font-bold text-fg">Pick what you pay for</h1>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          Every SpaceWorker capability, priced on its own — extraction, outreach, the
          desktop apps, and what&rsquo;s next as new modules ship. No bundle required to
          start.
        </p>
        <div className="mt-8">
          <Store />
        </div>
      </main>

      <footer className="mx-auto max-w-5xl border-t border-border px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-2 font-display font-bold text-fg">
            <LogoMark />
            <span>SpaceWorker OS</span>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm font-medium text-fg-muted hover:text-fg">
            <Link href="/#features" className="hover:text-fg">Features</Link>
            <Link href="/pricing" className="hover:text-fg">Pricing</Link>
            <Link href="/terms" className="hover:text-fg">Terms</Link>
            <Link href="/privacy" className="hover:text-fg">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function LogoMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#eaa53d" />
    </svg>
  );
}
