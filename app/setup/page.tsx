import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getAdminSession } from "@/lib/admin-auth";
import { env } from "@/lib/env";
import { isSelfHosted } from "@/lib/exe-build-target";
import { readSetupState } from "@/lib/self-hosted-setup-state";
import SetupWizard from "./setup-wizard";

// TASK_130 §2 — the first-run setup wizard page. Only meaningful on a
// self-hosted build: on our own hosted SaaS (SELF_HOSTED unset) it 404s, so
// this can never appear for a hosted customer. `force-dynamic` is required —
// the page reads the setup-state file at REQUEST time, and without it Next
// would prerender a build-time snapshot of it.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set up SpaceWorker" };

/**
 * The database step is informational only (TASK_130 §2 step 2): DATABASE_URL is
 * one of the four boot-required vars, so the page wouldn't be running without
 * it. We show host:port/dbname — never the password, query string, or full URL.
 */
function databaseLabel(raw: string): string {
  try {
    const url = new URL(raw);
    const db = url.pathname.replace(/^\//, "") || "(default database)";
    return `${url.hostname}${url.port ? `:${url.port}` : ""} / ${db}`;
  } catch {
    return "(configured — could not parse DATABASE_URL for display)";
  }
}

export default async function SetupPage() {
  if (!isSelfHosted()) notFound();

  const state = await readSetupState();

  // TASK_130 §3 re-entry gate, applied to the page too: once setup is complete,
  // a visitor with no admin session gets a dead-end notice instead of a
  // re-runnable wizard. An admin can still walk it again (e.g. to add device
  // management later).
  if (state.completedAt && !(await getAdminSession())) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-bg-elevated p-8 text-center shadow-sm">
          <h1 className="text-xl font-bold text-fg">Setup already complete</h1>
          <p className="mt-2 text-sm text-fg-muted">
            This SpaceWorker instance has already been configured. Sign in to the admin panel if
            you need to change its settings.
          </p>
          <Link
            href="/admin/login"
            className="mt-6 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Go to admin sign-in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <SetupWizard
      databaseLabel={databaseLabel(env.databaseUrl)}
      emailConfigured={env.resendApiKey.trim().length > 0}
      initialLicenseValidated={Boolean(state.license)}
    />
  );
}
