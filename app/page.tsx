import type { Metadata } from "next";
import Link from "next/link";

import { accountHref } from "@/lib/exe-runtime";

// Task 42 — the "SpaceWorker OS" landing page.
//
// TASK_100 (MK1-MK4, owner-directed reposition, 2026-09-22, phrasing finalized
// per M9): the page used to sell only leads ("find leads, then let the agent
// handle the outreach"). The product is a platform now — Vantra plugin (device
// control, remote tools, Wake-on-LAN/keep-awake), Browser Clone (act-as-you on
// a hosted browser), the AI agent, extraction and outreach all live and real
// (TASK_93/96/97 confirmed live 2026-09-26, the gate this rewrite was waiting
// on) — so the copy is rewritten platform-first, outcome-led (research anchor:
// Wiz/CrowdStrike platform pages), and the store moves off this page onto its
// own route (MK3, app/store/page.tsx) rather than living inline here.
//
// MK2 note: this repo's own convention is "unreleased modules render as
// 'coming soon' only once they exist" (dark-launch friendly) — Cyber Lab
// (TASK_98) has no dashboard route at all yet, so it is NOT listed below,
// not even as "coming soon." Add it here the day its route actually exists.

export const metadata: Metadata = {
  title: "SpaceWorker OS — Your Cloud Cyber Partner",
  description:
    "An AI assistant that runs your devices, finds and reaches your customers, and defends your PCs — with you approving every action.",
};

const NAV = [
  { label: "Features", href: "/#features" },
  { label: "Store", href: "/store" },
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

      {/* Hero — MK1 */}
      <section className="mx-auto max-w-5xl px-4 py-20 text-center sm:px-6">
        <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-3 py-1 text-xs font-medium text-fg-muted">
          AI Assistant · Device Control · Cybersecurity
        </p>
        <h1 className="mt-5 text-4xl font-bold text-fg sm:text-5xl">
          SpaceWorker OS — Your Cloud Cyber Partner
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-fg-muted mx-auto">
          An AI assistant that runs your devices, finds and reaches your customers, and
          defends your PCs — with you approving every action.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href={accountHref("/signup")}
            className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Start free
          </Link>
          <Link href="/store" className="rounded-lg border border-border bg-bg-elevated px-5 py-2.5 text-sm font-semibold text-fg hover:bg-black/5">
            Browse the store
          </Link>
        </div>
      </section>

      {/* Capability pillars — MK2 */}
      <section id="features" className="scroll-mt-24">
        <div className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            What SpaceWorker does
          </p>
          <h2 className="mt-3 text-3xl font-bold text-fg">One platform, approving every action with you</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            <Pillar
              title="Find & Reach"
              desc="Search the web from clean, persistent browser profiles, extract businesses and contacts into a clean lead list, and run outreach campaigns — subject/sender rotation, test-send confirmation, per-recipient variables."
              items={["Lead extraction", "Outreach campaigns", "Browser profiles"]}
            />
            <Pillar
              title="Assistant & Devices"
              desc="Chat with the SpaceWorker agent, review the plan it proposes, and approve it — it runs devices you own, launches apps and files remotely, keeps machines awake or wakes them, and clones a hosted browser as you when you need to act from elsewhere."
              items={["AI agent + approvals", "Remote device control", "Keep-awake / Wake-on-LAN", "Browser Clone"]}
            />
            <Pillar
              title="Automate"
              desc="Scheduled daily runs that start extraction and outreach on their own, plus digests and Telegram approvals so you stay in the loop without babysitting a dashboard."
              items={["Automations", "Digests", "Phone/Telegram approvals"]}
            />
          </div>
        </div>
      </section>

      {/* Footer — MK4 */}
      <footer className="mx-auto max-w-5xl border-t border-border px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-2 font-display font-bold text-fg">
            <LogoMark />
            <span>SpaceWorker OS</span>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm font-medium text-fg-muted hover:text-fg">
            <Link href="/store" className="hover:text-fg">Store</Link>
            <Link href="/pricing" className="hover:text-fg">Pricing</Link>
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

function Pillar({ title, desc, items }: { title: string; desc: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 text-left">
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      <p className="mt-2 text-sm text-fg-muted">{desc}</p>
      <ul className="mt-4 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item}
            className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-xs font-medium text-fg-muted"
          >
            {item}
          </li>
        ))}
      </ul>
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
