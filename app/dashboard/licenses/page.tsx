import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { ExeLicensePanel } from "@/app/dashboard/settings/exe-license-panel";
import { LicensesSection } from "@/app/dashboard/settings/licenses-section";
import { accountHref, isLocalExeRuntime } from "@/lib/exe-runtime";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Licenses — SpaceWorker OS" };

// Task 42, item 6 — the post-purchase license page. This is where the EXE term
// (a real 6-month expiry) is first disclosed on a screen, alongside the honest
// "download coming soon" status. Deliberately NOT linked before a purchase.
//
// Task 45 — for a license_only session (an EXE-only buyer) this is the ONLY
// dashboard page they can reach (proxy.ts's LICENSE_ONLY_ALLOWED_PAGE_PREFIXES),
// so it must carry the honest "want the full web app too?" up-sell plus the
// password on-ramp to becoming a real customer.
//
// TASK_100 MK5 (owner, 2026-09-22) — Licenses moves INTO Settings for a normal
// (full-scope) web session; the actual content now lives in
// app/dashboard/settings/licenses-section.tsx (shared by both pages, so
// nothing here duplicates its rendering). This page keeps working via
// redirect so old bookmarks/links don't break — but ONLY for a full session.
// A license_only session must NEVER be redirected to /dashboard/settings:
// proxy.ts does not allow that session scope onto Settings at all, and doing
// so would bounce it straight back here, an infinite redirect loop. The
// isLocalExeRuntime (desktop EXE) branch is unaffected either way — that
// build has no concept of a "session scope" at all.
export default async function LicensesPage() {
  // Desktop EXE runs fully offline — reuse the same ExeLicensePanel Settings
  // already shows (it talks exclusively to /api/exe-license/*, never the DB).
  if (isLocalExeRuntime()) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Licenses</h1>
        <p className="mt-2 text-sm text-fg-muted">Licensing for this device.</p>
        <div className="mt-6">
          <ExeLicensePanel buyHref={accountHref("/pricing")} />
        </div>
      </div>
    );
  }

  const session = await getSession();
  if (session?.scope !== "license_only") {
    redirect("/dashboard/settings#licenses");
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Licenses</h1>
      <div className="mt-6">
        <Card className="p-6">
          <LicensesSection />
        </Card>
      </div>
    </div>
  );
}
