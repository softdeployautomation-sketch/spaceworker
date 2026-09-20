import { NextRequest, NextResponse } from "next/server";

import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
import { exeBuildTarget } from "@/lib/exe-build-target";

// GET /api/exe/billing/checkout?kind=btc|usdt_trc20|usdt_erc20 — proxies the
// hosted /api/billing/checkout (already unauthenticated for EXE products, no
// change needed there) with `product` pinned to THIS build's own EXE product
// — the "Buy now" tab never shows a product picker, there's only one product
// this build can ever activate. Gated by isLocalExeRuntime() like every other
// /api/exe/* route.
export async function GET(req: NextRequest) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const kind = req.nextUrl.searchParams.get("kind") ?? "";
  const durationDays = req.nextUrl.searchParams.get("durationDays") ?? "";
  const product = `${exeBuildTarget()}_exe`;

  let res: Response;
  try {
    const qs = new URLSearchParams({ kind, product });
    if (durationDays) qs.set("durationDays", durationDays);
    res = await fetch(`${HOSTED_APP_URL}/api/billing/checkout?${qs.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the store. Check your connection and try again." }, { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
