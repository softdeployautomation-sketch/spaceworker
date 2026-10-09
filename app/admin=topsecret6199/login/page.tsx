import type { Metadata } from "next";
import Link from "next/link";

import { AdminLoginForm } from "@/components/admin/admin-login-form";
import { adminConfigured } from "@/lib/admin-auth";

export const metadata: Metadata = { title: "Admin sign in" };

export default function AdminLoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4">
      <Link href="/" className="mb-6 text-xl font-bold text-brand-600">
        SpaceWorker · Admin
      </Link>
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-elevated p-8 shadow-sm">
        <h1 className="text-xl font-bold text-fg">Admin sign in</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Enter the admin passcode to manage SpaceWorker.
        </p>
        {!adminConfigured() && (
          <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            The admin panel is locked because ADMIN_TOKEN isn&apos;t configured.
          </div>
        )}
        <div className="mt-6">
          <AdminLoginForm />
        </div>
      </div>
    </div>
  );
}