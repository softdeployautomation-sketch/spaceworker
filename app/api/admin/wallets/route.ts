import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { ALL_PRODUCTS, type AdminSettingPriceFields } from "@/lib/products";

const PRICE_FIELDS = ALL_PRODUCTS.map((p) => p.priceField);

// TASK_99 (2026-09-26) — reads/writes every product's price generically from
// ALL_PRODUCTS instead of a hand-maintained field list, so adding a product
// to lib/products.ts is the only change a future module/EXE ever needs here.
function priceFieldsOf(settings: Record<string, unknown>): AdminSettingPriceFields {
  const out = {} as Record<string, number>;
  for (const field of PRICE_FIELDS) out[field] = settings[field] as number;
  return out as AdminSettingPriceFields;
}

// GET /api/admin/wallets — read the AdminSetting singleton (created with defaults if missing).
export async function GET() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const settings = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: {},
    create: {},
  });

  return NextResponse.json({
    btcWallet: settings.btcWallet,
    usdtWallet: settings.usdtWallet,
    usdtErc20Wallet: settings.usdtErc20Wallet,
    // PLAN_TASK_167 W4 — the minimum top-up, so the floor can be changed without a
    // deploy. Read AND written here rather than in a route of its own because it
    // lives in the same singleton as the payout addresses and the prices, and this
    // is already the tab that edits that row.
    walletTopupMinUsd: settings.walletTopupMinUsd,
    ...priceFieldsOf(settings),
  });
}

// PUT /api/admin/wallets — body: wallet addresses + any/all product prices.
export async function PUT(req: Request) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: {
    btcWallet?: string | null;
    usdtWallet?: string | null;
    usdtErc20Wallet?: string | null;
    [priceField: string]: string | number | null | undefined;
  } = {};

  if (body.btcWallet !== undefined) {
    if (typeof body.btcWallet !== "string") {
      return NextResponse.json({ error: "btcWallet must be a string" }, { status: 400 });
    }
    data.btcWallet = body.btcWallet.trim() || null;
  }
  if (body.usdtWallet !== undefined) {
    if (typeof body.usdtWallet !== "string") {
      return NextResponse.json({ error: "usdtWallet must be a string" }, { status: 400 });
    }
    data.usdtWallet = body.usdtWallet.trim() || null;
  }
  if (body.usdtErc20Wallet !== undefined) {
    if (typeof body.usdtErc20Wallet !== "string") {
      return NextResponse.json({ error: "usdtErc20Wallet must be a string" }, { status: 400 });
    }
    data.usdtErc20Wallet = body.usdtErc20Wallet.trim() || null;
  }

  // PLAN_TASK_167 W4 — the minimum top-up. Validated here with the same "> 0"
  // rule as the prices, which is also what the migration's CHECK constraint
  // enforces, so a bad value is refused here with a clear message rather than
  // thrown by the database as an opaque 500.
  if (body.walletTopupMinUsd !== undefined) {
    const min = Number(body.walletTopupMinUsd);
    if (!Number.isFinite(min) || min <= 0) {
      return NextResponse.json(
        { error: "walletTopupMinUsd must be greater than 0" },
        { status: 400 },
      );
    }
    data.walletTopupMinUsd = min;
  }

  for (const field of PRICE_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json(
        { error: `${field} must be greater than 0` },
        { status: 400 },
      );
    }
    data[field] = price;
  }

  const settings = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  return NextResponse.json({
    btcWallet: settings.btcWallet,
    usdtWallet: settings.usdtWallet,
    usdtErc20Wallet: settings.usdtErc20Wallet,
    walletTopupMinUsd: settings.walletTopupMinUsd,
    ...priceFieldsOf(settings),
  });
}
