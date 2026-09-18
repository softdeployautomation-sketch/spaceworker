import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { EXE_PRODUCTS } from "@/lib/products";
import { generateLicenseKey } from "@/lib/exe-license";

// POST /api/admin/exe-licenses — manually issue an EXE license outside the
// checkout flow (a comp, an off-platform payment, support replacement). Gated by
// the admin session like every /api/admin/* route. Runs synchronously: key
// generation is one HMAC + a small DB write, so there's no real background job
// needed (Task 47 — a loading state reads the same to the admin as an async one).
//
// DESIGN DECISION (called out rather than guessed): ExeLicense.paymentId is a
// REQUIRED unique FK to a real Payment row, and a manually-issued license has no
// checkout Payment. Rather than make paymentId nullable (a schema change that
// weakens the one-to-one invariant), we create a minimal SYNTHETIC Payment row
// (kind "manual", status "approved", amountUsd 0) to satisfy the FK. This keeps
// ExeLicense.paymentId a genuine foreign key, needs zero migration, and preserves
// the repo's "auditable rows" convention — every license, manual or bought,
// traces back to a Payment parent with the same shape.

export async function POST(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { email?: unknown; product?: unknown; durationDays?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const productId = typeof body.product === "string" ? body.product.trim() : "";
  const product = EXE_PRODUCTS.find((p) => p.id === productId);

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter the buyer's email address." }, { status: 400 });
  }
  if (!product) {
    return NextResponse.json(
      { error: "Pick a valid SpaceWorker EXE product." },
      { status: 400 },
    );
  }

  let durationDays = undefined as number | undefined;
  if (body.durationDays !== undefined && body.durationDays !== null && body.durationDays !== "") {
    const n = Number(body.durationDays);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json(
        { error: "Duration (days) must be a positive whole number." },
        { status: 400 },
      );
    }
    durationDays = n;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json(
      { error: `No SpaceWorker user exists for ${email}.` },
      { status: 400 },
    );
  }

  let key;
  try {
    key = generateLicenseKey({
      licensee: user.email,
      plan: product.plan ?? product.id,
      product: product.id,
      daysValid: durationDays,
    });
  } catch {
    return NextResponse.json(
      { error: "Licensing is not configured on the server (EXE_LICENSE_SECRET unset)." },
      { status: 500 },
    );
  }

  // One atomic write: the synthetic Payment parent + the ExeLicense row, so a
  // crash can never leave an orphan license (or a payment without a license).
  const license = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        userId: user.id,
        // "manual" = no on-chain method; a bookkeeping sentinel that marks this
        // row as the synthetic parent of an admin-issued license, not a real buy.
        kind: "manual",
        amountUsd: 0,
        txHash: null,
        toAddress: "manual-admin-issuance",
        product: product.id,
        status: "approved",
      },
    });

    return tx.exeLicense.create({
      data: {
        userId: user.id,
        paymentId: payment.id,
        product: product.id,
        licenseKey: key.licenseKey,
      },
    });
  });

  return NextResponse.json({
    licenseKey: key.licenseKey,
    product: product.id,
    productName: product.name,
    licensee: user.email,
    expiresAt: key.expiresAt.toISOString(),
    exeLicenseId: license.id,
  });
}