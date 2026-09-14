import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { ALL_PRODUCTS, type ProductId } from "@/lib/products";

const PRICE_FIELDS: Record<ProductId, string> = Object.fromEntries(
  ALL_PRODUCTS.map((p) => [p.id, p.priceField]),
) as Record<ProductId, string>;

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
    webSubscriptionPriceUsd: settings.webSubscriptionPriceUsd,
    extractorExePriceUsd: settings.extractorExePriceUsd,
    mailerExePriceUsd: settings.mailerExePriceUsd,
    combinedExePriceUsd: settings.combinedExePriceUsd,
    automationExePriceUsd: settings.automationExePriceUsd,
  });
}

// PUT /api/admin/wallets — body: wallet addresses + any/all of the five prices.
export async function PUT(req: Request) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    btcWallet?: unknown;
    usdtWallet?: unknown;
    webSubscriptionPriceUsd?: unknown;
    extractorExePriceUsd?: unknown;
    mailerExePriceUsd?: unknown;
    combinedExePriceUsd?: unknown;
    automationExePriceUsd?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: {
    btcWallet?: string | null;
    usdtWallet?: string | null;
    webSubscriptionPriceUsd?: number;
    extractorExePriceUsd?: number;
    mailerExePriceUsd?: number;
    combinedExePriceUsd?: number;
    automationExePriceUsd?: number;
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

  for (const [, field] of Object.entries(PRICE_FIELDS)) {
    const raw = (body as unknown as Record<string, unknown>)[field];
    if (raw === undefined) continue;
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json(
        { error: `${field} must be greater than 0` },
        { status: 400 },
      );
    }
    // The safe shape of `data` is an AdminSetting patch; write the dynamic field
    // through a loose index before passing the concrete object to Prisma below.
    (data as unknown as Record<string, unknown>)[field] = price;
  }

  const settings = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  return NextResponse.json({
    btcWallet: settings.btcWallet,
    usdtWallet: settings.usdtWallet,
    webSubscriptionPriceUsd: settings.webSubscriptionPriceUsd,
    extractorExePriceUsd: settings.extractorExePriceUsd,
    mailerExePriceUsd: settings.mailerExePriceUsd,
    combinedExePriceUsd: settings.combinedExePriceUsd,
    automationExePriceUsd: settings.automationExePriceUsd,
  });
}