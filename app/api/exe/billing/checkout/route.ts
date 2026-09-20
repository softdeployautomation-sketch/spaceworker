import { NextRequest, NextResponse } from "next/server";

import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { hostedFetch, MAX_MAINTENANCE_RETRIES } from "@/lib/hosted-fetch";
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

  const qs = new URLSearchParams({ kind, product });
  if (durationDays) qs.set("durationDays", durationDays);
  const { response: res } = await hostedFetch(
    `/api/billing/checkout?${qs.toString()}`,
    { method: "GET" },
    { maxRetries: MAX_MAINTENANCE_RETRIES, timeoutMs: 15_000 },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
