import { NextResponse } from "next/server";
import { getAdminSettings } from "@/lib/admin-settings";
import { ALL_PRODUCTS } from "@/lib/products";

// GET /api/store/prices — PUBLIC (no session/admin required). The current
// launch prices for every product sold on the store/landing/pricing pages, for
// the store UI to render. Prices are admin-adjustable at runtime, so the store
// must read them live rather than hardcode the defaults.
export async function GET() {
  const settings = await getAdminSettings();
  const products = ALL_PRODUCTS.map((p) => ({
    id: p.id,
    name: p.name,
    tagline: p.tagline,
    kind: p.kind,
    priceUsd: settings[p.priceField],
  }));
  return NextResponse.json({ products });
}