import type { Metadata } from "next";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { Badge, Card } from "@/components/ui";
import { LicenseUpgradeForm } from "@/components/license-upgrade-form";
import { getSession } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session-user";
import { prisma } from "@/lib/prisma";
import { getProduct } from "@/lib/products";
import { EXE_LICENSE_DAYS } from "@/lib/exe-license";

export const metadata: Metadata = { title: "Licenses — SpaceWorker OS" };

// Task 42, item 6 — the post-purchase license page. This is where the EXE term
// (a real 6-month expiry) is first disclosed on a screen, alongside the honest
// "download coming soon" status. Deliberately NOT linked before a purchase.
//
// Task 45 — for a license_only session (an EXE-only buyer) this is the ONLY
// dashboard page they can reach, so it must carry the honest "want the full web
// app too?" up-sell plus the password on-ramp to becoming a real customer. The
// restriction itself is enforced centrally by proxy.ts (Next.js 16 renamed the
// middleware.ts convention to proxy.ts), not by hiding a nav
// link.
export default async function LicensesPage() {
  const user = await getCurrentUser();
  if (!user) return null; // dashboard layout gates auth anyway

  const session = await getSession();
  const isLicenseOnly = session?.scope === "license_only";

  const licenses = await prisma.exeLicense.findMany({
    where: { userId: user.id },
    orderBy: { issuedAt: "desc" },
  });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Licenses</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Your desktop-app license keys. Each is linked to the product you bought.
      </p>

      {isLicenseOnly && (
        <div className="mt-6 space-y-5">
          <Card className="p-5">
            <h2 className="text-lg font-semibold text-fg">
              Want the full web app too?
            </h2>
            <p className="mt-2 text-sm text-fg-muted">
              Your desktop licenses are all here. The web app — private browser,
              lead extraction, campaigns, automations and the AI agent — is a
              separate subscription.
            </p>
            <Link
              href="/pricing"
              className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Subscribe →
            </Link>
          </Card>

          <Card className="p-5">
            <h2 className="text-lg font-semibold text-fg">Set a password</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Choose a password so you can sign in to a full account later.
            </p>
            <div className="mt-4 max-w-sm">
              <LicenseUpgradeForm />
            </div>
          </Card>
        </div>
      )}

      {licenses.length === 0 ? (
        <Card className="mt-6 p-6">
          <p className="text-sm text-fg-muted">You don&rsquo;t have any desktop licenses yet.</p>
          <Link href="/pricing" className="mt-2 text-sm font-semibold text-brand-600 hover:underline">
            Browse desktop apps →
          </Link>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          {licenses.map((lic) => {
            const product = getProduct(lic.product);
            const name = product?.name ?? lic.product;
            const validUntil = new Date(lic.issuedAt.getTime() + EXE_LICENSE_DAYS * 24 * 60 * 60 * 1000);
            return (
              <Card key={lic.id} className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold">{name}</h2>
                  <Badge tone="success">Active</Badge>
                </div>

                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-fg-muted">License key</dt>
                    <dd className="flex items-center gap-2">
                      <code className="max-w-[420px] truncate break-all text-xs">{lic.licenseKey}</code>
                      <CopyButton value={lic.licenseKey} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-fg-muted">Issued</dt>
                    <dd>{lic.issuedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-fg-muted">Valid until</dt>
                    <dd>
                      <span className="font-medium">
                        {validUntil.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                      </span>
                      <span className="text-fg-muted"> ({EXE_LICENSE_DAYS} days from issue)</span>
                    </dd>
                  </div>
                </dl>

                <p className="mt-4 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg-muted">
                  <strong>Download coming soon</strong> — we&rsquo;ll email you the moment the
                  desktop app is ready. Your key is already active and will work immediately once
                  you download.
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}