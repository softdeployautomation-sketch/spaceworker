import type { Metadata } from "next";
import Link from "next/link";

import { VerifyForm } from "@/components/verify-form";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const params = await searchParams;
  const email = params.email ?? "";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4">
      <Link href="/" className="mb-6 text-xl font-bold text-brand-600">
        SpaceWorker
      </Link>
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-elevated p-8 shadow-sm">
        <h1 className="text-xl font-bold text-fg">Check your email</h1>
        <p className="mt-1 text-sm text-fg-muted">
          We sent a 6-digit code to{" "}
          <span className="font-medium text-fg">{email || "your inbox"}</span>.
          Enter it below to activate your account.
        </p>
        <div className="mt-6">
          <VerifyForm email={email} />
        </div>
      </div>
    </div>
  );
}