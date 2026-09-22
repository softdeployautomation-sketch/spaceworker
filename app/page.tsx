import type { Metadata } from "next";
import Link from "next/link";

import { Store } from "@/components/store";
import { accountHref, isLocalExeRuntime } from "@/lib/exe-runtime";

// Task 42 — the redesigned "SpaceWorker OS" landing page (marketing page +
// app store). Hero + capability grid + the store section + footer, built
// against the Night Studio design tokens (globals.css / layout.tsx / ui.tsx).

export const metadata: Metadata = { title: "SpaceWorker OS" };

const NAV = [
  { label: "Features", href: "/#features" },
  { label: "Store", href: "/#store" },
  { label: "Pricing", href: "/pricing" },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-bg">
      {/* Top nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-display font-bold text-fg">
            <LogoMark />
            <span>SpaceWorker OS</span>
          </Link>
          <nav className="hidden gap-5 text-sm font-medium text-fg-muted hover:text-fg md:flex">
            {NAV.map((item) => (
              <Link key={item.label} href={item.href} className="hover:text-fg">
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <Link href={accountHref("/login")} className="text-sm font-semibold text-fg-muted hover:text-fg">
              Sign in
            </Link>
            <Link
              href={accountHref("/signup")}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-4 py-20 text-center sm:px-6">
        <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-3 py-1 text-xs font-medium text-fg-muted">
          Lead extraction + AI-assisted outreach
        </p>
        <h1 className="mt-5 text-4xl font-bold text-fg sm:text-5xl">
          SpaceWorker OS — find leads, then let the agent handle the outreach
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-fg-muted">
          Search the web from clean, persistent browser profiles, extract businesses
          and contacts, and run outreach campaigns. Tell the SpaceWorker agent what
          leads you need, review the plan it proposes, and approve it — it runs the
          parts of the workflow for you.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href={accountHref("/signup")}
            className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Start free
          </Link>
          <Link href="/#store" className="rounded-lg border border-border bg-bg-elevated px-5 py-2.5 text-sm font-semibold text-fg hover:bg-black/5">
            Browse the store
          </Link>
        </div>
      </section>

      {/* Capabilities */}
      <section id="features" className="scroll-mt-24">
        <div className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            Capabilities
          </p>
          <h2 className="mt-3 text-3xl font-bold text-fg">Everything in one workspace</h2>
          <ul className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Capability title="Private browser" desc="A real, persistent browser you drive from your dashboard, with a sticky IP that isn't linkable to your real network." />
            <Capability title="Lead extraction" desc="Run searches and collect businesses & contact detail into a clean, exportable lead list." />
            <Capability title="Outreach" desc="Campaign mailings with subject & sender rotation, test-send confirmation, and per-recipient variables." />
            <Capability title="Browser profiles" desc="Per-user profiles that keep your browsing context and fingerprints separate and persistent." />
            <Capability title="AI agent" desc="Chat-driven campaign planning, autonomous deliverability diagnostics, and staged proposals you review and approve." />
            <Capability title="Automations" desc="Scheduled daily runs that start extraction and outreach on their own — set it once, it keeps going." />
          </ul>
        </div>
      </section>

      {/* Store — confirmed live (2026-09-19): inside the EXE's bundled local
          runtime, /api/store/prices has no DATABASE_URL either (same gap as
          the auth links above), so the Store component's fetch always fails
          there ("Failed to load the store."). Hand off to the real hosted
          store instead of showing a broken/empty section. */}
      <section id="store" className="mx-auto max-w-5xl px-4 py-16 sm:px-6 scroll-mt-24">
        {isLocalExeRuntime() ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center">
            <p className="text-sm text-fg-muted">
              Store pricing needs a live connection to our website.
            </p>
            <Link
              href={accountHref("/#store")}
              className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Open the store on spaceworker.top
            </Link>
          </div>
        ) : (
          <Store />
        )}
      </section>

      {/* Footer */}
      <footer className="mx-auto max-w-5xl border-t border-border px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-2 font-display font-bold text-fg">
            <LogoMark />
            <span>SpaceWorker OS</span>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm font-medium text-fg-muted hover:text-fg">
            <Link href="/pricing" className="hover:text-fg">Pricing</Link>
            <Link href="/#store" className="hover:text-fg">Store</Link>
            <Link href="/terms" className="hover:text-fg">Terms</Link>
            <Link href="/privacy" className="hover:text-fg">Privacy</Link>
          </nav>
        </div>
        <p className="mt-6 text-xs text-fg-muted">
          © {new Date().getFullYear()} SpaceWorker OS. Cold-outreach content and recipient
          lists are your responsibility as the sender.
        </p>
      </footer>
    </div>
  );
}

function Capability({ title, desc }: { title: string; desc: string }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4 text-sm text-fg-muted">
      <span className="font-semibold text-fg">{title}</span> — {desc}
    </li>
  );
}

function LogoMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#eaa53d" />
    </svg>
  );
}