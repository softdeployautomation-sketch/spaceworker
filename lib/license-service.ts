import "server-only";

import { db } from "./db";
import { exeLicenseIssuedEmailHtml, sendEmail } from "./email";
import { generateLicenseKey } from "./exe-license";
import {
  generateLicenseClaimToken,
  hashLicenseClaimToken,
  LICENSE_CLAIM_TTL_MS,
} from "./license-claim";
import { getProduct } from "./products";
import { env } from "./env";
import { grantPremium, grantXDeviceTerm, PREMIUM_DAYS_PER_CHARGE } from "./premium";
import { grantEntitlement, type EntitlementKey } from "./entitlements";

// Task 42, item 5 — the one place that finalizes an APPROVED payment into its
// product's consequence. All three approval paths funnel through here:
//   - POST /api/billing/submit       (payment auto-confirmed on-chain, instantly)
//   - app/api/internal/payment-verify/route.ts (the on-chain poller)
//   - app/api/admin/payments/[id]/approve/route.ts (manual admin review)
// Centralizing it keeps the branch-on-product logic in exactly one file instead
// of being copy-pasted across three routes and drifting.
//
// Idempotent: called once per approval, guarded by the approved-status check and
// the ExeLicense.paymentId unique constraint, so a retry never double-mints.

// ---------------------------------------------------------------------------
// TASK_184 B4 — settle the PremiumInvoice a payment was submitted against.
//
// CLAIM-THEN-GRANT, deliberately: the conditional updateMany (status:"open" ⇒
// "paid") is the atomic claim, so of two approvals racing on the same invoice
// exactly ONE grants. Read-then-grant would let both see "open" and stack two
// terms for one invoice.
//
// Order's failure mode, accepted on purpose: if the grant throws AFTER the
// claim, the invoice reads paid with no grant — but the approval route's retry
// (retry-license ⇒ handleApprovedPayment) then gets `false` here and falls
// through to the normal product branch, which grants the same tier anyway. The
// opposite order (grant first) would double-grant on a race, which has no such
// recovery.
//
// The grant IS the existing grant-premium path: grantPremium (tier 5) or
// grantXDeviceTerm (tier 3), one term exactly like bumpWebTier — no new grant
// code, and no term/duration is ever rendered for the user (TASK_181 wording
// rule). TASK_187 B6: the length of that term is `invoice.days ??` the
// standard PREMIUM_DAYS_PER_CHARGE, so an admin's per-invoice override is
// applied HERE and nowhere else — while a NULL `days` (every pre-TASK_187
// invoice) settles exactly as before.
//
// Returns true only when THIS call settled the invoice (claim won AND grant
// ran). False = nothing to settle (no ref / not own / not open / claim lost).
// ---------------------------------------------------------------------------
type LinkedInvoicePayment = { id: string; userId: string; invoiceId: string | null };

export async function settleLinkedInvoice(payment: LinkedInvoicePayment): Promise<boolean> {
  if (!payment.invoiceId) return false;
  const invoice = await db.premiumInvoice.findUnique({ where: { id: payment.invoiceId } });
  // Not found / not this user's / not open ⇒ nothing to settle — caller runs its
  // default consequence. (Ownership is defense-in-depth: submit/topup validated
  // it at creation, but a forged ref must not settle somebody else's invoice.)
  if (!invoice || invoice.userId !== payment.userId || invoice.status !== "open") return false;

  const claim = await db.premiumInvoice.updateMany({
    where: { id: invoice.id, status: "open" },
    data: { status: "paid", paidAt: new Date() },
  });
  if (claim.count === 0) return false; // lost the race — another approval settled it

  // TASK_187 B6 — the admin's per-invoice term override wins when set; NULL
  // keeps the standard term, so pre-TASK_187 invoices are unaffected.
  const days = invoice.days ?? PREMIUM_DAYS_PER_CHARGE;
  if (invoice.tier === 3) {
    await grantXDeviceTerm(payment.userId, days);
  } else {
    await grantPremium(payment.userId, days);
  }
  return true;
}

/**
 * Applies the consequence of an already-approved payment: for a web subscription
 * this is today's exact tier bump; for any EXE product it issues a license key
 * (and emails it with the real 6-month expiry). Safe to call any number of times
 * for the same payment — it only acts on transitions that haven't happened yet.
 */
export async function handleApprovedPayment(paymentId: string): Promise<void> {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { user: { select: { id: true, email: true } } },
  });
  if (!payment || payment.status !== "approved") return;
  // TASK_184 B4 — an invoice-linked payment: the INVOICE owns this approval's
  // consequence (settle it + grant the invoice's own tier). True ⇒ return without
  // the product branch below — one payment, one consequence, so a premium_plus
  // invoice payment never ALSO runs bumpWebTier (the term would stack twice).
  // False (no ref / invoice already settled by an earlier approval) ⇒ the normal
  // product consequence runs, which is also the recovery path for a retry after
  // a failed grant (see settleLinkedInvoice).
  if (payment.invoiceId && (await settleLinkedInvoice(payment))) return;
  if (!payment.product || payment.product === "web_subscription") {
    await bumpWebTier(payment.userId);
    return;
  }
  // TASK_181 P3 (step 27) — the XDevice wrapper premium: a tier-3 TERM, never
  // a tier bump. grantXDeviceTerm stacks onto a live tier-3 term and holds the
  // HARD RULE that an active tier-5 account is never lowered by this purchase.
  if (payment.product === "xdevice") {
    await grantXDeviceTerm(payment.userId);
    return;
  }
  const product = getProduct(payment.product);
  if (product?.kind === "module") {
    await grantModuleEntitlements(payment.userId, product.entitlementKeys ?? []);
    return;
  }
  try {
    await issueExeLicense(payment);
  } catch (err) {
    // Confirmed live (2026-09-19) — every caller marks the payment "approved"
    // BEFORE calling this function, with no try/catch of their own. Left
    // unhandled, a throw here (e.g. an unrecognized product id) permanently
    // stranded the payment "approved" with no ExeLicense ever created and
    // nothing to retry it — a real buyer pays, admin confirms, and nothing
    // happens, silently. Revert to "flagged" so it reappears in the admin
    // review queue (same Approve button retries this exact idempotent path
    // once the underlying issue is fixed) and log an audit attempt, matching
    // the existing verification-attempt pattern elsewhere in this flow.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[exe-license] payment ${paymentId} approved but license issuance failed:`, message);
    await db.payment
      .update({ where: { id: paymentId }, data: { status: "flagged" } })
      .catch(() => {});
    await db.paymentVerificationAttempt
      .create({ data: { paymentId, success: false, note: `license issuance failed: ${message}` } })
      .catch(() => {});
    throw err;
  }
}

// TASK_99 / plan §COMMERCIAL C3 (owner, 2026-09-26) — a module product's
// consequence: grant its entitlement key(s) instead of bumping tier. Priced
// and termed exactly like the web subscription (flat monthly, no duration
// concept), so it uses the SAME recurring-term constant — each successful
// payment extends the grant by another charge period (grantEntitlement now
// stacks onto an unexpired existing term, matching grantPremium exactly).
// Idempotent by construction: grantEntitlement is an upsert.
async function grantModuleEntitlements(userId: string, keys: EntitlementKey[]): Promise<void> {
  for (const key of keys) {
    await grantEntitlement({ userId, key, source: "module", expiresInDays: PREMIUM_DAYS_PER_CHARGE });
  }
}

async function bumpWebTier(userId: string): Promise<void> {
  // Tier 1 trial — Premium is tier 5 (was 1). tier 1 is now the free trial;
  // a real web-subscription payment must always grant the FULL paid tier and
  // never the trial. No-op-safe: idempotent for an already-5 account.
  //
  // Task 55 — now time-limited: real web-subscription payments get a 30-day
  // premium term (matching how the store page already markets "$79.97 / month"
  // as a recurring charge). Existing pre-task tier-5 users with premiumExpiresAt
  // null stay grandfathered forever (see lib/premium.ts). Behavior change for
  // FUTURE purchases only — flagged in the Task 55 report.
  await grantPremium(userId, PREMIUM_DAYS_PER_CHARGE);
}

async function issueExeLicense(payment: {
  id: string;
  userId: string;
  product: string;
  durationDays?: number | null;
  user: { id: string; email: string };
}): Promise<void> {
  const productId = payment.product;
  const existing = await db.exeLicense.findUnique({
    where: { paymentId: payment.id },
  });
  if (existing) return; // idempotency — never double-mint

  const product = getProduct(productId);
  if (!product || product.kind !== "exe" || !product.plan) {
    throw new Error(`Unknown EXE product for payment ${payment.id}: "${productId}"`);
  }

  // The term actually paid for (1/6/12 months) — null/unset means the
  // product's standard 180-day term, unchanged from before this existed.
  const daysValid = payment.durationDays ?? undefined;

  const { licenseKey, expiresAt } = generateLicenseKey({
    licensee: payment.user.email,
    plan: product.plan,
    daysValid,
    product: productId,
  });

  // Storing the license is the source of truth; the email is the buyer's
  // disclosure of the real term. Store first so the dashboard/email can never
  // reference a key that doesn't exist — and so a failed send loses nothing.
  const license = await db.exeLicense.create({
    data: {
      userId: payment.userId,
      paymentId: payment.id,
      product: productId,
      licenseKey,
    },
  });

  // Task 45 — mint a single-use claim link so an EXE-only buyer (who may have no
  // web account and no known password) can view their key by proving email
  // ownership. The link resolves to a NARROW license_only session — never a full
  // one. Storing happens with issuance so a failed email still leaves a working
  // link the buyer can be re-sent later.
  const claimToken = generateLicenseClaimToken();
  const claimExpiresAt = new Date(Date.now() + LICENSE_CLAIM_TTL_MS);
  await db.exeLicense.update({
    where: { id: license.id },
    data: {
      licenseClaimTokenHash: hashLicenseClaimToken(claimToken),
      licenseClaimTokenExpiresAt: claimExpiresAt,
    },
  });
  const claimUrl = `${env.appBaseUrl}/api/exe-license/claim?token=${encodeURIComponent(claimToken)}`;

  // A real transactional email, unconditionally (not via notifyUser's
  // preference fan-out) — this is the buyer's disclosure moment for the term,
  // so it must always reach the email they paid with.
  try {
    await sendEmail({
      to: payment.user.email,
      subject: `Your ${product.name} purchase is confirmed`,
      html: exeLicenseIssuedEmailHtml({
        productName: product.name,
        licenseKey,
        expiresAt,
        claimUrl,
      }),
      eventType: "exe_license_issued",
    });
  } catch (err) {
    // The license row + key are already saved; the buyer can still retrieve the
    // key from /dashboard/licenses once they log in. Log loudly, don't roll back.
    console.error(
      `[exe-license] issued key for payment ${payment.id} but failed to email it:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}