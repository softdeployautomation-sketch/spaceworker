import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";

import { createCaptchaChallenge } from "@/lib/captcha";
import { getReferralLinkByCode, validateReferral } from "@/lib/referral";
import CaptchaGrid from "@/components/captcha-grid";
import SupportForm from "@/components/support-form";
import { accountHref } from "@/lib/exe-runtime";

// Public homepage — replaced by the SpaceWorker invite-only waiting room.
//
// The public face of the site is now a clown CAPTCHA plus a support message
// form. /login and /signup are referral-gated (sw_ref cookie), and referral
// links (/r/:code) set that cookie, so the only way onto the auth forms is via
// an invite shared by an existing user.
export const metadata: Metadata = {
  title: "SpaceWorker — Invite Only",
  description:
    "SpaceWorker is invite-only. Get a referral link from an existing user, complete the CAPTCHA, then sign in or sign up.",
};

const REFERRAL_COOKIE = "sw_ref";

export default async function HomePage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const cookieStore = await cookies();
  const refCookie = cookieStore.get(REFERRAL_COOKIE)?.value;
  const refQuery = Array.isArray(searchParams.ref)
    ? searchParams.ref[0]
    : searchParams.ref;

  // Resolve + (for a fresh ?ref link) stamp the referral cookie.
  let link = await (async () => {
    if (refCookie) return validateReferral(refCookie);
    return null;
  })();
  if (!link && refQuery) {
    link = await validateReferral(refQuery);
    if (link) {
      cookieStore.set(REFERRAL_COOKIE, refQuery, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
  }

  // Fresh clown CAPTCHA challenge for this page load.
  const captcha = await createCaptchaChallenge();

  const error = searchParams.error;
  const hasReferral = !!link;

  return (
    <div className="min-h-screen bg-[#fbe7e6] text-[#7f1d1d]">
      {/* Clown nose hero */}
      <header className="border-b border-[#f4c2c2] bg-[#ffe4e2]/80 backdrop-blur sticky top-0 z-40">
        <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🤡</span>
            <span className="font-display font-bold text-xl tracking-tight">
              SpaceWorker
            </span>
          </div>
          <p className="mt-1 text-xs text-[#9f3434]">
            Invite-only — you need a referral link to sign in or sign up.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:py-20">
        {/* Clown hero image */}
        <div className="flex flex-col items-center gap-4 mb-10 text-center">
          <div className="relative inline-block">
            <div className="relative w-40 h-40 rounded-full bg-[#ffe4e2] border-4 border-[#ffd166] shadow-lg overflow-hidden">
              <div className="absolute inset-0 bg-[#ffd166]/20 animate-pulse"></div>
              {/* big clown nose */}
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full bg-[#ff4d4d] ring-4 ring-[#b91c1c]"></div>
              <div className="absolute left-1/6 top-1/4 w-3 h-3 rounded-full bg-[#1f2937]"></div>
              <div className="absolute right-1/6 top-1/4 w-3 h-3 rounded-full bg-[#1f2937]"></div>
              <div className="absolute left-1/2 top-2/3 -translate-x-1/2 w-8 h-1 bg-[#ef4444] rounded-full"></div>
            </div>
            <span className="absolute -bottom-6 text-xs text-[#9f3434]">
              The Invite-Only Clown Gate
            </span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome to the clown gate.
          </h1>
          <p className="text-lg text-[#9f3434]">
            SpaceWorker isn't open to the public. Get an invite link from an
            existing user, prove you're human below, then sign in or sign up.
          </p>
        </div>

        {/* Referral status */}
        {hasReferral ? (
          <div className="mb-8 rounded-xl border border-[#ffd166] bg-[#fff7ed] p-4 text-center text-[#92400e]">
            <p className="font-semibold">Referral accepted:</p>
            <p className="text-sm font-mono">{link.code}</p>
            <p className="mt-1 text-xs">
              You can now{" "}
              <Link
                href={accountHref("/login")}
                className="font-bold underline hover:text-[#b91c1c]"
              >
                sign in
              </Link>{" "}
              or{" "}
              <Link
                href={accountHref("/signup")}
                className="font-bold underline hover:text-[#b91c1c]"
              >
                create an account
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="mb-8 rounded-xl border border-[#fca5a5] bg-[#fef2f2] p-4 text-center text-[#991b1b]">
            <p className="font-semibold">No referral linked.</p>
            <p className="mt-1 text-xs">
              Ask an existing user for their invite link ("/r/:code"), or use
              the support form below to request access.
            </p>
          </div>
        )}
        {/* Clown CAPTCHA */}
        <section className="mb-10">
          <CaptchaGrid
            token={captcha.token}
            seed={captcha.seed}
            targetCount={captcha.targetCount}
            onVerified={() => {
              // Intentionally fire-and-forget on the client: the CAPTCHA gate
              // is advisory here — the real enforcement is the referral cookie
              // on /login and /signup.
            }}
          />
        </section>

        {/* Support message form */}
        <SupportForm />

        {error === "referral_required" && (
          <p className="mt-8 text-center text-sm text-[#991b1b]">
            That page needs a valid referral link first.
          </p>
        )}
      </main>

      <footer className="border-t border-[#f4c2c2] mx-auto max-w-5xl px-4 py-8 text-center text-xs text-[#9f3434]">
        © {new Date().getFullYear()} SpaceWorker OS. Invite-only access.
      </footer>
    </div>
  );
}

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
          One platform. Customers, devices, sites and defense.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-fg-muted mx-auto">
          An AI assistant that finds and reaches your customers, runs your devices, hosts
          what you publish, and tests your own systems — with you approving every action.
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
          {/* TASK_164 — `md:grid-cols-2 lg:grid-cols-3`, not `md:grid-cols-3`. Five tiles in
              a 3-wide grid leave two on the second row, and the last row of a ragged grid is
              the part a visitor reads as "this page is unfinished". 2-up on tablet stacks them
              evenly and 3-up on desktop gives 3 + 2, which is balanced. */}
          <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
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
            {/* TASK_164 — every claim here maps to a shipped surface in
                `components/hosting-panel.tsx`: the "Sites" tab (zip → preview → publish),
                the "Links" tab (user-owned /r/<slug>), the "Files" tab, and "Your domains".
                "Your own domain" is the honest phrasing: you register it elsewhere and point
                it at Cloudflare here. Nothing on this page implies we sell domains. */}
            <Pillar
              title="Hosting"
              desc="Publish files, pages and links and get a real URL back. Upload a folder and publish it as a site, share a short link you own, or serve files — and point any of it at a domain you already have, with per-plan storage and bandwidth caps you can see before you hit them."
              items={["Sites, files & short links", "Your own domain", "Live storage & bandwidth caps"]}
            />
            {/* TASK_164 — the owner ruled Cyber Lab ships as an available product with no
                "coming soon" and no beta label, so it is written as a live capability here.

                The wording is still bounded on purpose, and the bound is not marketing
                timidity — it mirrors `lib/lab/gate.ts`, which gates every run on the
                `cyberlab` entitlement, an admin switch, AND a recorded consent to the
                current terms, and which describes itself as "authorization hygiene, not a
                legal fence". Saying "test any target, attack anyone" would promise more
                than the gate enforces, and that is the specific overclaim this repo's docs
                keep warning about. "Authorised", "your own systems" and "recorded consent"
                are all things the product genuinely does today. */}
            <Pillar
              title="Cyber Lab"
              desc="Run authorised security research against your own systems — reconnaissance, exposure checks and vulnerability scans — from a research-only catalog. Every run needs your recorded consent to the current terms, and the catalog can only point at targets you are authorised to test."
              items={["Authorised recon", "Exposure & vulnerability scans", "Consent recorded per run"]}
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
