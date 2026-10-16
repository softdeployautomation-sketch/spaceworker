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
            <p className="text-sm font-mono">{link?.code}</p>
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
