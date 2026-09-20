import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getProduct } from "@/lib/products";
import {
  bindExeLicenseToMachine,
  transferExeLicenseToMachine,
  LicenseBindError,
  LicenseTransferError,
} from "@/lib/exe-license-bind";

export const dynamic = "force-dynamic";

// POST /api/exe-license/payment-status — body: { paymentId, machineId, machineLabel?, confirmTransfer? }
//
// Owner-requested 2026-09-20: "put the signup and payment flow [in the EXE],
// so users dont need to come to the web... they just get their license and
// can then click a reload license binding page button." Called by the
// desktop EXE's local runtime after a payment was submitted via the existing
// (already unauthenticated-for-EXE) /api/billing/submit — this is the
// "reload"/"check again" button's target.
//
// Not session-gated (the EXE has no web session) — the trust boundary is
// `paymentId` itself: a server-generated cuid, unguessable, known only to
// whoever just submitted that exact payment. Same trust model this codebase
// already uses for the license claim token. Scoped to EXE products only —
// this must never be usable to probe a web_subscription payment's status.
const bodySchema = z.object({
  paymentId: z.string().trim().min(1, "Missing payment id."),
  machineId: z.string().trim().min(1, "Missing device ID."),
  machineLabel: z.string().trim().max(80).optional().nullable(),
  confirmTransfer: z.boolean().optional(),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const payment = await db.payment.findUnique({ where: { id: parsed.paymentId } });
  if (!payment) {
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }
  const product = getProduct(payment.product);
  if (!product || product.kind !== "exe") {
    // Scope guard — never let this route report on a web_subscription payment.
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  }

  if (payment.status !== "approved") {
    return NextResponse.json({ done: false, status: payment.status });
  }

  const license = await db.exeLicense.findUnique({ where: { paymentId: payment.id } });
  if (!license) {
    // Approved but the license mint (handleApprovedPayment) hasn't landed yet —
    // a brief race on manual/poller approval. Tell the caller to retry shortly,
    // not an error.
    return NextResponse.json({ done: false, status: "approved", note: "License is being issued — check again shortly." });
  }

  try {
    const bound = await bindExeLicenseToMachine({
      exeLicenseId: license.id,
      machineId: parsed.machineId,
      machineLabel: parsed.machineLabel ?? undefined,
    });
    return NextResponse.json({ done: true, boundLicenseKey: bound.boundLicenseKey });
  } catch (err) {
    if (err instanceof LicenseBindError && err.code === "already_bound") {
      if (!parsed.confirmTransfer) {
        return NextResponse.json(
          {
            error:
              "This license is already active on another device. If that device is no longer in use, you can move it here.",
            code: "already_bound",
          },
          { status: 409 },
        );
      }
      try {
        const transferred = await transferExeLicenseToMachine({
          exeLicenseId: license.id,
          newMachineId: parsed.machineId,
          newMachineLabel: parsed.machineLabel ?? undefined,
          note: "Self-service transfer: confirmed while checking a fresh purchase's payment status.",
        });
        return NextResponse.json({ done: true, boundLicenseKey: transferred.boundLicenseKey });
      } catch (transferErr) {
        if (transferErr instanceof LicenseTransferError) {
          return NextResponse.json({ error: transferErr.message }, { status: 400 });
        }
        throw transferErr;
      }
    }
    if (err instanceof LicenseBindError) {
      const status = err.code === "not_found" ? 404 : 400;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
