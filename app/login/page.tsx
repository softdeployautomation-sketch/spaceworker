import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getSession } from "@/lib/auth";
import { hasAccessGate } from "@/lib/referral";
import { EXE_ADMIN_REFERRAL_CODE } from "@/lib/exe-runtime";


export const metadata: Metadata = { title: "Sign in" };

const REFERRAL_COOKIE = "sw_ref";

/**
 * /login is referral-gated: a visitor needs a valid `sw_ref` cookie (set when
 * they click a referral link /r/:code, or supplied as ?ref=CODE) before the
 * sign-in form is shown. Anyone else is bounced to the public homepage.
 */
// TASK_216 D1 — cookie-gated + redirect: force per-request rendering so the
// gate can never bake into the build artifact (see app/cyberlab/page.tsx).
export const dynamic = "force-dynamic";

export default async function LoginPage({

  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const cookieStore = await cookies();
  const refCookie = cookieStore.get(REFERRAL_COOKIE)?.value;
  const refQuery = Array.isArray(searchParams.ref)
    ? searchParams.ref[0]
    : searchParams.ref;

  // Access gate: cookie takes precedence, otherwise a ?ref=CODE link stamps the
  // cookie and proceeds. Accepts a valid universal referral OR an active,
  // unredeemed personalized invite (Model C). The hard invite email-match is
  // enforced later at signup, not here — this only decides "may they see the form".
  let hasAccess = refCookie ? await hasAccessGate(refCookie) : false;

  // TASK_XDEVICE — when the EXE's admin referral code came as ?ref=CODE (not via
  // /r/:code which already stamped sw_wrapper), stamp it here. Next 16 forbids
  // cookies().set() during Server Component render, so we redirect to a Route
  // Handler that stamps the cookie and sends us back.
  //
  // We only check refQuery here, not refCookie: if refCookie already equals the
  // EXE code, /r/:code already stamped sw_wrapper on the way in — no redirect needed.
  const needsReferralCookie = !hasAccess && !!refQuery;
  const needsWrapperCookie = refQuery === EXE_ADMIN_REFERRAL_CODE;

  if (needsReferralCookie || needsWrapperCookie) {
    const params = new URLSearchParams();
    if (needsReferralCookie) params.set("ref", refQuery!);
    if (needsWrapperCookie) params.set("wrapper", "true");
    params.set("redirect", "/login");
    redirect(`/api/auth/set-referral-cookie?${params.toString()}`);
  }

  if (!hasAccess) {
    // No valid referral/invite at all — cannot reach the login form.
    redirect("/?error=referral_required");
  }

  if (await getSession()) redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4">
      <Link href="/" className="mb-6 text-xl font-bold text-brand-600">
        SpaceWorker
      </Link>
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-elevated p-8 shadow-sm">
        <h1 className="text-xl font-bold text-fg">Welcome back</h1>
        <p className="mt-1 text-sm text-fg-muted">Sign in to your dashboard.</p>
        <div className="mt-6">
          <AuthForm mode="login" />
        </div>
        <p className="mt-6 text-center text-sm text-fg-muted">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-brand-600 hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}