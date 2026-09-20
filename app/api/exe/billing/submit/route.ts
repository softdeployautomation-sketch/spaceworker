import { NextResponse } from "next/server";

import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
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

  let body: { kind?: unknown; txHash?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const product = `${exeBuildTarget()}_exe`;
  let res: Response;
  try {
    res = await fetch(`${HOSTED_APP_URL}/api/billing/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: body.kind, txHash: body.txHash, email: body.email, product }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return NextResponse.json({ error: "Couldn't reach the store. Check your connection and try again." }, { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
