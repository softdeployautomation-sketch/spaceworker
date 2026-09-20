import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";
import {
  getProduct,
  WEB_SUBSCRIPTION,
  DEFAULT_EXE_DURATION_DAYS,
  isValidExeDurationDays,
  calculateExePrice,
} from "@/lib/products";

const KINDS = ["btc", "usdt_trc20", "usdt_erc20"] as const;
type Kind = (typeof KINDS)[number];

// GET /api/billing/checkout?kind=btc|usdt_trc20|usdt_erc20&product=<productId>&durationDays=30|180|365
// Returns payment instructions + wallet address + the price for the chosen
// term. The Payment row is created on submit.
//
// product defaults to web_subscription for back-compat. A web-subscription
// checkout still requires a session (the existing sign-up flow); an EXE
// checkout does NOT, so a not-yet-signed-up visitor can start a buy from the
// public store page (Task 27 Part A's "no account required first" requirement).
//
// durationDays is EXE-only (owner, 2026-09-20: "if anyone wants to buy more
// on there license they can buy for 1 year, and also for 1 month, just let
// the calculator do its thing") — ignored for web_subscription, which has no
// concept of a term. Defaults to the standard 180-day (6-month) term so
// every existing caller that never sends it keeps working unchanged.
export async function GET(req: NextRequest) {
  const session = await getSession();

  const kind = req.nextUrl.searchParams.get("kind");
  if (!kind || !KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
  }

  const productId = req.nextUrl.searchParams.get("product") ?? WEB_SUBSCRIPTION.id;
  const product = getProduct(productId);
  if (!product) {
    return NextResponse.json({ error: "Unknown product" }, { status: 400 });
  }

  // The web subscription keeps requiring an existing session (that's its whole
  // existing flow). EXE products are the store's no-login purchase path.
  if (product.kind === "web") {
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const durationParam = req.nextUrl.searchParams.get("durationDays");
  let durationDays = DEFAULT_EXE_DURATION_DAYS;
  if (product.kind === "exe" && durationParam !== null) {
    const parsed = Number(durationParam);
    if (!Number.isInteger(parsed) || !isValidExeDurationDays(parsed)) {
      return NextResponse.json({ error: "Invalid license term." }, { status: 400 });
    }
    durationDays = parsed;
  }

  const settings = await getAdminSettings();
  const toAddress =
    kind === "btc"
      ? settings.btcWallet
      : kind === "usdt_erc20"
        ? settings.usdtErc20Wallet
        : settings.usdtWallet;
  if (!toAddress) {
    return NextResponse.json({ error: "Wallet not configured" }, { status: 400 });
  }

  const amountUsd =
    product.kind === "exe"
      ? calculateExePrice(settings[product.priceField], durationDays)
      : settings[product.priceField];

  return NextResponse.json({
    product: product.id,
    kind,
    toAddress,
    amountUsd,
    durationDays: product.kind === "exe" ? durationDays : undefined,
    note: "Send exact amount ±5% to the address shown. Submit your transaction hash below.",
  });
}