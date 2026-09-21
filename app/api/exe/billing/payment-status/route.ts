import { NextResponse } from "next/server";

import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { hostedFetch, MAX_MAINTENANCE_RETRIES } from "@/lib/hosted-fetch";
import { getCachedMachineId } from "@/lib/license-state";
import { saveActivation } from "@/lib/license-state";

// POST /api/exe/billing/payment-status — body: { paymentId, confirmTransfer? }
//
// The "reload license binding" button: proxies the hosted /api/exe-license/
// payment-status, and on done:true saves the returned bound key locally
// exactly like /api/exe-license/activate does — from that point this device
// validates fully offline, indistinguishable from having pasted a key in by
// hand. Gated by isLocalExeRuntime() like every other /api/exe/* route.
export async function POST(req: Request) {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { paymentId?: unknown; confirmTransfer?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const paymentId = typeof body.paymentId === "string" ? body.paymentId.trim() : "";
  const confirmTransfer = body.confirmTransfer === true;
  if (!paymentId) {
    return NextResponse.json({ error: "Missing payment id." }, { status: 400 });
  }

  const currentMachineId = (await getCachedMachineId()).toLowerCase();
  const { response: res } = await hostedFetch(
    "/api/exe-license/payment-status",
    {
      method: "POST",
      body: JSON.stringify({ paymentId, machineId: currentMachineId, confirmTransfer }),
    },
    { maxRetries: MAX_MAINTENANCE_RETRIES, timeoutMs: 15_000 },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: typeof data.error === "string" ? data.error : "Couldn't check payment status.", code: data.code },
      { status: res.status },
    );
  }
  if (data.done !== true) {
    return NextResponse.json({ done: false, status: data.status, note: data.note });
  }
  if (typeof data.boundLicenseKey !== "string" || !data.boundLicenseKey) {
    return NextResponse.json({ error: "License server returned an unexpected response." }, { status: 502 });
  }

  const licensee = typeof body.email === "string" ? body.email : "";
  const state = await saveActivation({ licensee, licenseKey: data.boundLicenseKey, machineId: currentMachineId });
  return NextResponse.json({ done: true, licensed: true, activatedAt: state.activation?.activatedAt });
}
