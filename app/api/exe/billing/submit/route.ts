import { NextResponse } from "next/server";

import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { hostedFetch, MAX_MAINTENANCE_RETRIES } from "@/lib/hosted-fetch";
import { exeBuildTarget } from "@/lib/exe-build-target";

// POST /api/exe/billing/submit — body: { kind, txHash?, email } — proxies the
// hosted /api/billing/submit (already handles an unauthenticated EXE buyer:
// resolves/creates the account by email, no change needed there) with
// `product` pinned to THIS build's own EXE product. Returns the same
// { paymentId, status } shape the hosted route does — the EXE stores
// paymentId locally and uses it with /api/exe/billing/payment-status's
// "reload/check again" button, since a fresh purchase has no license key yet
// to activate with directly.
//
// Gated by isLocalExeRuntime() like every other /api/exe/* route.
export async function POST(req: Request) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { kind?: unknown; txHash?: unknown; email?: unknown; durationDays?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const product = `${exeBuildTarget()}_exe`;
  // Task 56, Mechanism 3 — hostedFetch rides out the deploy window (bounded
  // retry through 502/503 { maintenance: true }), so a purchase the user clicks
  // during an update still lands instead of surfacing a scary generic error.
  const { response: res } = await hostedFetch(
    "/api/billing/submit",
    {
      method: "POST",
      body: JSON.stringify({
        kind: body.kind,
        txHash: body.txHash,
        email: body.email,
        durationDays: body.durationDays,
        product,
      }),
    },
    { maxRetries: MAX_MAINTENANCE_RETRIES, timeoutMs: 20_000 },
  );
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
