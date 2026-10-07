import { NextResponse } from "next/server";

import { allowAndRecord, getClientIp } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session-user";
import { getAdminSettings } from "@/lib/admin-settings";
import { spendSubscription, spendXDevice } from "@/lib/wallet";

export const dynamic = "force-dynamic";

// PLAN_TASK_158 W5 — POST /api/wallet/spend, body { product }.
//
// TASK_181 P3 (step 28): TWO spendable products — "web_subscription"
// (spendSubscription → 30-day tier-5 term) and "xdevice" (spendXDevice →
// tier-3 XDevice term, mirroring the full W5 contract: 402 insufficient,
// 409 already_active, keyed replay 0-charge, CAS 409 wallet_contended).
// The loop-closer: funded balance (W3 grant + W4 top-up) becomes a term.
// Everything else — an EXE id, a module id, a missing field, a non-string —
// is refused here with 400, not priced, because minting a licence key
// from wallet balance does not exist yet.
//
// PRICE SOURCE. The cents charged come from the SAME AdminSetting field the
// crypto checkout reads (`webSubscriptionPriceUsd` via `getAdminSettings`),
// converted with Math.ceil(usd*100) — the same direction `creditApprovedPayment`
// uses, so the invoice can never be short of the credit. There is deliberately
// no amount, price or durationDays in the request body: a client-supplied
// number here would be a self-priced subscription.
//
// SESSION USER ONLY (same rule as GET /api/wallet): no userId param, no body
// id. ATOMICITY lives in `spendSubscription` — one $transaction for the CAS
// debit + tier/expiry write + ledger row.
//
// Failure shapes (plan §6.2 + W5 contract): insufficient = 402
// insufficient_funds; live term (incl. grandfathered tier-5 NULL expiry) =
// 409 already_active, REFUSED never extended (a second tap must not eat a
// second month); concurrent spend = 409 wallet_contended via CAS; anything
// but web_subscription = 400.
export async function POST(req: Request) {
  const ip = await getClientIp();
  // wallet-spend, not wallet-read: this moves money (billing-submit posture).
  if (!(await allowAndRecord(ip, "wallet-spend"))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429 },
    );
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { product?: unknown; idempotencyKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // TASK_181 P3: two spendable products. The string must match exactly —
  // anything else is refused BEFORE any price is read or money touched.
  const productId = body.product;
  if (productId !== "web_subscription" && productId !== "xdevice") {
    return NextResponse.json(
      {
        error:
          typeof productId === "string" && productId.length > 0
            ? `Wallet spend is not available for "${productId}" yet — web subscription and XDevice Premium only.`
            : "Unknown product. Wallet spend covers the web subscription and XDevice Premium only.",
        code: "unsupported_product",
      },
      { status: 400 },
    );
  }

  const settings = await getAdminSettings();
  const priceUsd = productId === "xdevice" ? settings.xdevicePriceUsd : settings.webSubscriptionPriceUsd;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return NextResponse.json({ error: "Subscription price is not configured." }, { status: 500 });
  }
  // Ceil, matching creditApprovedPayment's direction: the charge never rounds
  // down below the invoiced dollars.
  const priceCents = Math.ceil(priceUsd * 100);

  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim().length > 0
      ? body.idempotencyKey.trim().slice(0, 200)
      : undefined;

  const result =
    productId === "xdevice"
      ? await spendXDevice({ userId: user.id, priceCents, idempotencyKey })
      : await spendSubscription({ userId: user.id, priceCents, idempotencyKey });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    product: productId,
    balanceCents: result.value.balanceCents,
    premiumExpiresAt: result.value.premiumExpiresAt.toISOString(),
    chargedCents: result.value.chargedCents,
  });
}
