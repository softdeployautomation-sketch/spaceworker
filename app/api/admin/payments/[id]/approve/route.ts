import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { handleApprovedPayment } from "@/lib/license-service";
import { creditApprovedPayment } from "@/lib/wallet";
import { isWalletTopup } from "@/lib/products";

// POST /api/admin/payments/[id]/approve — manually approve a payment and
// finalize it into its product's consequence (web => tier bump, EXE => license
// issue) via the single shared handler.
//
// PLAN_TASK_167 W4b adds ONE product to that list: a `wallet_topup` credits a
// wallet and does nothing else. Read the branch below before changing anything
// near it — this is the highest-consequence branch in the billing system, because
// the default arm sells licences and the owner sells those products for a living.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (payment.status === "approved" || payment.status === "rejected") {
    // This is the double-approval guard for a top-up as well as a licence: a
    // second click is refused here, before the credit branch is even reached, and
    // `creditApprovedPayment` has its own UNIQUE index on paymentId behind it.
    // Two independent guards, because this is the button that moves money.
    return NextResponse.json({ error: "Payment already finalized" }, { status: 400 });
  }

  // ---- PLAN_TASK_167 W4b: a top-up credits a wallet, and NOTHING else ---------
  //
  // `handleApprovedPayment` is DELIBERATELY not called in this arm. It is the one
  // function that turns an approval into a product: it bumps the web tier, grants
  // module entitlements, or mints and emails an EXE licence. A top-up paid for none
  // of those, so calling it here would hand a customer who topped up $10 a
  // subscription — the precise inversion plan §4b warns about, in the direction
  // that costs real money.
  //
  // `creditApprovedPayment` is the whole credit path, and it was written for
  // exactly this: the user id comes from the PAYMENT ROW (there is no userId
  // parameter to get wrong), the amount is bounded by what was invoiced, and
  // `creditedCents` + `adminNote` are written in the SAME transaction as the
  // balance (plan §8.5) so a crash cannot leave a payment approved with an
  // uncredited wallet.
  if (isWalletTopup(payment.product)) {
    const creditCents = Math.ceil(payment.amountUsd * 100);
    const credited = await creditApprovedPayment({
      paymentId: payment.id,
      amountCents: creditCents,
      adminNote: "Wallet top-up approved",
    });
    if (!credited.ok) {
      // The payment is deliberately LEFT non-approved. Marking it approved and then
      // failing the credit is the state §8.5 exists to prevent: an admin who sees
      // "approved" reasonably believes the customer has their money. Leaving it
      // flagged puts it back in the review queue, where Approve is the retry.
      return NextResponse.json({ error: credited.message }, { status: credited.status });
    }

    // The status flip happens AFTER the credit, which is the other half of §8.5:
    // the credit is committed, then the order is marked done. A crash in between
    // leaves an approved-looking payment that is not yet approved — and the UNIQUE
    // index on paymentId means the admin's retry credits nothing a second time.
    await prisma.payment.update({ where: { id }, data: { status: "approved" } });
    await prisma.paymentVerificationAttempt.create({
      data: { paymentId: id, success: true, note: "Wallet top-up credited" },
    });

    return NextResponse.json({
      ok: true,
      product: "wallet_topup",
      creditedCents: credited.value.amountCents,
      balanceCents: credited.value.balanceCents,
    });
  }
  // ---- end PLAN_TASK_167 W4b -------------------------------------------------

  // Everything below is the pre-existing path, unchanged. A subscription or EXE
  // purchase must behave exactly as it did before the top-up existed.
  await prisma.payment.update({ where: { id }, data: { status: "approved" } });
  await handleApprovedPayment(id);

  return NextResponse.json({ ok: true });
}