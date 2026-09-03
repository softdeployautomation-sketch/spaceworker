import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

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
    planPriceUsd: settings.planPriceUsd,
  });
}

// PUT /api/admin/wallets — body: { btcWallet?, usdtWallet?, planPriceUsd? }
export async function PUT(req: Request) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { btcWallet?: unknown; usdtWallet?: unknown; planPriceUsd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const data: {
    btcWallet?: string | null;
    usdtWallet?: string | null;
    planPriceUsd?: number;
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
  if (body.planPriceUsd !== undefined) {
    const price = Number(body.planPriceUsd);
    if (!Number.isFinite(price) || price <= 0) {
      return NextResponse.json({ error: "planPriceUsd must be greater than 0" }, { status: 400 });
    }
    data.planPriceUsd = price;
  }

  const settings = await prisma.adminSetting.upsert({
    where: { id: "singleton" },
    update: data,
    create: data,
  });

  return NextResponse.json({
    btcWallet: settings.btcWallet,
    usdtWallet: settings.usdtWallet,
    planPriceUsd: settings.planPriceUsd,
  });
}