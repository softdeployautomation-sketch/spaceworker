import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getSession } from "@/lib/auth";
import { hasAccessGate } from "@/lib/referral";

export const metadata: Metadata = { title: "Create account" };

// TASK_216 D1 — cookie/searchParams-gated + redirect: force per-request
// rendering so the gate can never bake into the build artifact (see
// app/cyberlab/page.tsx).
export const dynamic = "force-dynamic";

const REFERRAL_COOKIE = "sw_ref";

/**
 * /signup is referral-gated: a visitor needs a valid `sw_ref` cookie (set when
 * they click a referral link /r/:code, or supplied as ?ref=CODE) before the
 * sign-up form is shown. Anyone else is bounced to the public homepage.
 */
export default async function SignupPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Reading it synchronously made
  // ?ref=CODE invisible, so every EXE "Get started" link bounced to
  // /?error=referral_required even though the code was valid. Await it.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Same gap as app/login/page.tsx — an already-logged-in visitor shouldn't
  // see a signup form.
  if (await getSession()) redirect("/dashboard");

  const cookieStore = await cookies();
  const refCookie = cookieStore.get(REFERRAL_COOKIE)?.value;
  const resolvedSearchParams = await searchParams;
  const refQuery = Array.isArray(resolvedSearchParams.ref)
    ? resolvedSearchParams.ref[0]
    : resolvedSearchParams.ref;

  // Access gate (Model C): a valid universal referral OR an active, unredeemed
  // personalized invite lets the visitor reach the signup form. The hard invite
  // email-match is enforced in the POST /api/auth/signup route, not here.
  let hasAccess = refCookie ? await hasAccessGate(refCookie) : false;

  if (!hasAccess && refQuery) {
    hasAccess = await hasAccessGate(refQuery);
    if (!hasAccess) redirect("/?error=referral_required");
    // Next 16 forbids cookies().set() during a Server Component render, so the
    // ref is NOT stamped here. <AuthForm> forwards ?ref= in the signup POST
    // body, and the route validates/attributes it there. (The /r/:code route
    // handler still sets sw_ref for the normal web flow.)
  }

  if (!hasAccess) redirect("/?error=referral_required");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4">
      <Link href="/" className="mb-6 text-xl font-bold text-brand-600">
        SpaceWorker
      </Link>
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-elevated p-8 shadow-sm">
        <h1 className="text-xl font-bold text-fg">Create your account</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Free to start. Verify your email to finish signing up.
        </p>
        <div className="mt-6">
          <AuthForm mode="signup" />
        </div>
        <p className="mt-6 text-center text-sm text-fg-muted">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}