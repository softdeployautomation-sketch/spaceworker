import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { EXE_PRODUCTS } from "@/lib/products";
import { generateLicenseKey } from "@/lib/exe-license";
import { bindExeLicenseToMachine, LicenseBindError } from "@/lib/exe-license-bind";

// /api/admin/exe-licenses — the admin "EXE licenses" tool.
//   POST { action: "issue", email, product, durationDays? }  -> issue a NEW EXE
//        license outside the checkout flow (a comp, an off-platform payment, a
//        support replacement). Unchanged from before Task 47.
//   POST { action: "bind", email, exeLicenseId, machineId, machineLabel? } -> CLAIM
//        an existing (unbound) license to a machine — the admin manual tool for
//        one-real-machine-per-license. Re-signs the key with the device's
//        machine_id, preserving the original expiry, and stores the bound key.
//   GET  ?email=... -> list that buyer's licenses (product, issuedAt, claimed?,
//        bound machine) so the admin can pick which unclaimed key to claim.
// All gated by the admin session like every /api/admin/* route.
//
// POST runs synchronously: key generation is one HMAC + a small DB write, so
// there's no real background job needed (Task 47 — a loading state reads the
// same to the admin as an async one).
//
// DESIGN DECISION (called out rather than guessed): ExeLicense.paymentId is a
// REQUIRED unique FK to a real Payment row, and a manually-issued license has no
// checkout Payment. Rather than make paymentId nullable (a schema change that
// weakens the one-to-one invariant), we create a minimal SYNTHETIC Payment row
// (kind "manual", status "approved", amountUsd 0) to satisfy the FK. This keeps
// ExeLicense.paymentId a genuine foreign key and preserves the repo's "auditable
// rows" convention — every license, manual or bought, traces back to a Payment
// parent with the same shape.

export async function POST(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter the buyer's email address." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json(
      { error: `No SpaceWorker user exists for ${email}.` },
      { status: 400 },
    );
  }

  const action = body.action === "bind" ? "bind" : "issue";
  if (action === "bind") {
    return bindLicense(user.id, user.email, body);
  }
  return issueLicense(user, body);
}

// ---- bind (claim an existing license to a machine) --------------------------

async function bindLicense(
  userId: string,
  userEmail: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const exeLicenseId = typeof body.exeLicenseId === "string" ? body.exeLicenseId.trim() : "";
  const machineId = typeof body.machineId === "string" ? body.machineId.trim() : "";
  const machineLabel =
    typeof body.machineLabel === "string" && body.machineLabel.trim()
      ? body.machineLabel.trim()
      : null;

  if (!exeLicenseId) {
    return NextResponse.json({ error: "Pick which license to claim." }, { status: 400 });
  }

  // Ownership gate: the license MUST belong to the buyer the admin named.
  const license = await prisma.exeLicense.findUnique({ where: { id: exeLicenseId } });
  if (!license || license.userId !== userId) {
    return NextResponse.json(
      { error: `No license for ${userEmail} matches that selection.` },
      { status: 400 },
    );
  }

  try {
    const bound = await bindExeLicenseToMachine({ exeLicenseId, machineId, machineLabel });
    return NextResponse.json({
      bound: true,
      licenseKey: bound.boundLicenseKey,
      boundMachineId: bound.boundMachineId,
      boundMachineLabel: bound.boundMachineLabel,
      boundAt: bound.boundAt.toISOString(),
      exeLicenseId,
      product: bound.product,
      productName: bound.productName,
      licensee: bound.licensee,
      expiresAt: bound.expiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof LicenseBindError) {
      const status = err.code === "not_found" ? 404 : err.code === "already_bound" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}

// ---- issue (a brand-new license, unchanged behaviour) ------------------------

async function issueLicense(
  user: { id: string; email: string },
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const productId = typeof body.product === "string" ? body.product.trim() : "";
  const product = EXE_PRODUCTS.find((p) => p.id === productId);
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

// ---- GET ?email=... — list a buyer's licenses for the claim picker -----------

export async function GET(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const email = new URL(req.url).searchParams.get("email")?.trim() ?? "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Pass ?email=... to list a buyer's licenses." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    return NextResponse.json({ licenses: [] });
  }

  const licenses = await prisma.exeLicense.findMany({
    where: { userId: user.id },
    orderBy: { issuedAt: "desc" },
  });

  return NextResponse.json({
    licenses: licenses.map((l) => ({
      id: l.id,
      product: l.product,
      productName: EXE_PRODUCTS.find((p) => p.id === l.product)?.name ?? l.product,
      issuedAt: l.issuedAt.toISOString(),
      boundMachineId: l.boundMachineId,
      boundMachineLabel: l.boundMachineLabel,
      boundLicenseKey: l.boundLicenseKey,
      boundAt: l.boundAt?.toISOString() ?? null,
    })),
  });
}