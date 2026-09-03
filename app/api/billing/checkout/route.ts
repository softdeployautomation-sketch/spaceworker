import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";

const KINDS = ["btc", "usdt_trc20"] as const;
type Kind = (typeof KINDS)[number];

// GET /api/billing/checkout?kind=btc|usdt_trc20
// Returns payment instructions + wallet address. The Payment row is created on submit.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kind = req.nextUrl.searchParams.get("kind");
  if (!kind || !KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
  }

  const settings = await getAdminSettings();
  const toAddress = kind === "btc" ? settings.btcWallet : settings.usdtWallet;
  if (!toAddress) {
    return NextResponse.json({ error: "Wallet not configured" }, { status: 400 });
  }

  return NextResponse.json({
    kind,
    toAddress,
    amountUsd: settings.planPriceUsd,
    note: "Send exact amount ±5% to the address shown. Submit your transaction hash below.",
  });
}