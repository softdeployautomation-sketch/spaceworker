import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { Badge, Card } from "@/components/ui";
import { LicenseUpgradeForm } from "@/components/license-upgrade-form";
import { getSession } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session-user";
import { prisma } from "@/lib/prisma";
import { getProduct } from "@/lib/products";
import { decodeLicenseKey, isLifetimeExpiry } from "@/lib/exe-license";
import { originalExpiry } from "@/lib/exe-license-bind";

// TASK_100 MK5 (owner, 2026-09-22) — Licenses moves into Settings as a
// section. Extracted byte-identical from the former full-page rendering in
// app/dashboard/licenses/page.tsx (which now redirects here for a normal web
// session) so a license_only / EXE session — which still lands on
// /dashboard/licenses directly, per proxy.ts's LICENSE_ONLY_ALLOWED_PAGE_PREFIXES
// and the local-EXE branch — keeps seeing EXACTLY what it always has; only
// the FULL web session's destination for this content changed.
export async function LicensesSection() {
  const user = await getCurrentUser();
  if (!user) return null;

  const session = await getSession();
  const isLicenseOnly = session?.scope === "license_only";

  const licenses = await prisma.exeLicense.findMany({
    where: { userId: user.id },
    orderBy: { issuedAt: "desc" },
  });

  return (
    <div id="licenses">
      <h2 className="text-lg font-semibold text-fg">Licenses</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Your desktop-app license keys. Each is linked to the product you bought.
      </p>

      {isLicenseOnly && (
        <div className="mt-4 space-y-4">
          <Card className="p-5">
            <h3 className="text-base font-semibold text-fg">Want the full web app too?</h3>
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
            <h3 className="text-base font-semibold text-fg">Set a password</h3>
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
        <Card className="mt-4 p-6">
          <p className="text-sm text-fg-muted">You don&rsquo;t have any desktop licenses yet.</p>
          <Link href="/pricing" className="mt-2 text-sm font-semibold text-brand-600 hover:underline">
            Browse desktop apps →
          </Link>
        </Card>
      ) : (
        <div className="mt-4 space-y-4">
          {licenses.map((lic) => {
            const product = getProduct(lic.product);
            const name = product?.name ?? lic.product;
            // TASK_145 T8 (senior §3 D7 item 1) — the term is a property of the
            // signed key, not a hardcoded constant and not a DB column. Decode
            // the key's own `expires_at`; a lifetime grant is the same payload
            // shape with the far-future sentinel, so `isLifetimeExpiry` (never a
            // literal year) is the only classifier. An undecodable/malformed key
            // degrades to a neutral label instead of throwing during render.
            const keyPayload = decodeLicenseKey(lic.licenseKey);
            const expiresAt = keyPayload?.expires_at ? originalExpiry(lic.licenseKey) : null;
            const hasExpiry =
              expiresAt !== null && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > 0;
            const isLifetime = hasExpiry && isLifetimeExpiry(expiresAt);
            const remainingDays =
              hasExpiry && expiresAt
                ? Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
                : null;
            const isBound = lic.boundMachineId != null && lic.boundMachineId !== "";
            const issuedLabel = lic.issuedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
            const validUntilLabel =
              hasExpiry && expiresAt
                ? expiresAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
                : null;
            return (
              <Card key={lic.id} className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">{name}</h3>
                  {isBound ? (
                    <Badge tone="success">Active — bound</Badge>
                  ) : (
                    <Badge tone="warning">Needs activation</Badge>
                  )}
                </div>

                <dl className="mt-4 space-y-2 text-sm">
                  {!isBound && (
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-fg-muted">Purchase reference</dt>
                      <dd className="flex items-center gap-2">
                        <code className="max-w-[420px] truncate break-all text-xs">{lic.licenseKey}</code>
                        <CopyButton value={lic.licenseKey} />
                      </dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-fg-muted">Issued</dt>
                    <dd>{issuedLabel}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-fg-muted">Valid until</dt>
                    <dd>
                      {isLifetime ? (
                        <span className="font-medium">No expiry (lifetime)</span>
                      ) : validUntilLabel ? (
                        <>
                          <span className="font-medium">{validUntilLabel}</span>
                          <span className="text-fg-muted">
                            {" "}
                            ({remainingDays != null && remainingDays > 0 ? `${remainingDays} days remaining` : "Expired"})
                          </span>
                        </>
                      ) : (
                        <span className="text-fg-muted">Not available</span>
                      )}
                    </dd>
                  </div>
                </dl>

                {isBound ? (
                  <p className="mt-4 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg-muted">
                    This license is locked to a single device. Activating it in the desktop
                    app on a new machine moves it there automatically.
                  </p>
                ) : (
                  <p className="mt-4 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-fg-muted">
                    Not activated anywhere yet — the key above is a purchase reference. Open
                    the desktop app, paste this key and your email into its License screen,
                    and it locks to that device automatically. There&rsquo;s nothing to set up
                    here.
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
