import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { EXE_PRODUCTS } from "@/lib/products";
import { generateLicenseKey } from "@/lib/exe-license";
import { bindExeLicenseToMachine, LicenseBindError, transferExeLicenseToMachine, LicenseTransferError, unbindExeLicense, keyExpiryIsAfter, originalExpiry } from "@/lib/exe-license-bind";

// /api/admin/exe-licenses — the admin "EXE licenses" tool.
//   POST { action: "issue", email, product, durationDays? }  -> issue a NEW EXE
//        license outside the checkout flow (a comp, an off-platform payment, a
//        support replacement). Unchanged from before Task 47.
//   POST { action: "bind", email, exeLicenseId, machineId, machineLabel? } -> CLAIM
//        an existing (unbound) license to a machine — the admin manual tool for
//        one-real-machine-per-license. Re-signs the key with the device's
//        machine_id, preserving the original expiry, and stores the bound key.
//   POST { action: "transfer", email, exeLicenseId, newMachineId, newMachineLabel?,
//        note? } -> ADMIN/SELF-SERVICE-ONLY DEVICE TRANSFER: move an ALREADY-BOUND
//        license from its current machine to a new device (Task 47 addition). The
//        ONE action that deliberately overwrites an existing binding (bind/claim
//        refuses to). Re-signs the ORIGINAL unbound key for the new device,
//        preserving the true original expiry, updates the bound key, and appends
//        a durable ExeLicenseTransfer audit row — atomically, in one transaction.
//        No buyer-facing equivalent: letting buyers freely re-bind would defeat
//        the one-device-per-license guarantee.
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

  const action =
    body.action === "transfer" ? "transfer" : body.action === "bind" ? "bind" : body.action === "unbind" ? "unbind" : "issue";
  if (action === "bind") {
    return bindLicense(user.id, user.email, body);
  }
  if (action === "transfer") {
    return transferLicense(user.id, user.email, body);
  }
  if (action === "unbind") {
    return unbindLicense(user.id, user.email, body);
  }
  return issueLicense(user, body);
}

// ---- unbind (clear a binding back to "unclaimed" — admin support/testing) ----
// Resets a license to the same state a fresh, never-claimed issue starts in, so
// the next bind (self-service or admin) re-signs from the ORIGINAL unbound key
// exactly as if this one had never been claimed. Same ownership gate as bind/
// transfer. No self-service equivalent — same DRM reasoning as transfer.

async function unbindLicense(
  userId: string,
  userEmail: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const exeLicenseId = typeof body.exeLicenseId === "string" ? body.exeLicenseId.trim() : "";
  if (!exeLicenseId) {
    return NextResponse.json({ error: "Pick which license to unbind." }, { status: 400 });
  }

  const license = await prisma.exeLicense.findUnique({ where: { id: exeLicenseId } });
  if (!license || license.userId !== userId) {
    return NextResponse.json(
      { error: `No license for ${userEmail} matches that selection.` },
      { status: 400 },
    );
  }

  try {
    const result = await unbindExeLicense(exeLicenseId);
    return NextResponse.json({ unbound: true, exeLicenseId: result.id, wasBound: result.wasBound });
  } catch (err) {
    if (err instanceof LicenseBindError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === "not_found" ? 404 : 400 });
    }
    throw err;
  }
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

// ---- transfer (move an already-bound license to a new device — admin/support) --
// Task 47 addition. Deliberately the ONLY action that overwrites an existing
// binding (bind/claim refuses to). An admin support replacement: a buyer replaced
// a laptop / lost a machine and legitimately needs the license on a new device.
// Same ownership shape as bind — the license MUST belong to the named buyer —
// and admin-gated like every other action here. There is NO self-service version
// of this: letting buyers freely re-bind would defeat the one-device guarantee.

async function transferLicense(
  userId: string,
  userEmail: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const exeLicenseId = typeof body.exeLicenseId === "string" ? body.exeLicenseId.trim() : "";
  const newMachineId = typeof body.newMachineId === "string" ? body.newMachineId.trim() : "";
  const newMachineLabel =
    typeof body.newMachineLabel === "string" && body.newMachineLabel.trim()
      ? body.newMachineLabel.trim()
      : null;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  if (!exeLicenseId) {
    return NextResponse.json({ error: "Pick which bound license to transfer." }, { status: 400 });
  }
  if (!newMachineId) {
    return NextResponse.json({ error: "Enter the new Device ID to move this license to." }, { status: 400 });
  }

  // Ownership gate: the license MUST belong to the buyer the admin named.
  const license = await prisma.exeLicense.findUnique({ where: { id: exeLicenseId } });
  if (!license || license.userId !== userId) {
    return NextResponse.json(
      { error: `No license for ${userEmail} matches that selection.` },
      { status: 400 },
    );
  }
  if (!license.boundMachineId) {
    return NextResponse.json(
      { error: "This license isn't bound to a device yet — claim (bind) it first before transferring." },
      { status: 409 },
    );
  }

  try {
    const moved = await transferExeLicenseToMachine({
      exeLicenseId,
      newMachineId,
      newMachineLabel,
      note,
    });
    return NextResponse.json({
      transferred: true,
      licenseKey: moved.boundLicenseKey,
      boundMachineId: moved.boundMachineId,
      boundMachineLabel: moved.boundMachineLabel,
      movedFromMachineId: moved.movedFromMachineId,
      movedAt: moved.movedAt.toISOString(),
      exeLicenseId,
      product: moved.product,
      productName: moved.productName,
      licensee: moved.licensee,
      expiresAt: moved.expiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof LicenseTransferError) {
      const status = err.code === "not_found" ? 404 : err.code === "not_bound" ? 409 : err.code === "not_configured" ? 500 : 400;
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

  // Confirmed live (2026-09-19) — this used to mint a BRAND NEW row every
  // single call, with no check for an existing one first. One buyer ended up
  // with several separate ExeLicense rows for the same product after
  // repeated admin "issue" clicks — confusing in admin, and no real reason
  // for a user to ever have more than one usable license per product at a
  // time. Reuse an existing non-expired one if there is one, whatever its
  // bind state — only mint a genuinely new row when none exists or the
  // existing one(s) have actually expired.
  const now = new Date();
  const existingRows = await prisma.exeLicense.findMany({
    where: { userId: user.id, product: product.id },
    orderBy: { issuedAt: "desc" },
  });
  const reusable = existingRows.find((l) => keyExpiryIsAfter(l.licenseKey, now));
  if (reusable) {
    return NextResponse.json({
      reused: true,
      licenseKey: reusable.licenseKey,
      product: reusable.product,
      productName: product.name,
      licensee: user.email,
      expiresAt: originalExpiry(reusable.licenseKey).toISOString(),
      exeLicenseId: reusable.id,
      boundMachineId: reusable.boundMachineId,
      mustClaimNote: reusable.boundMachineId
        ? "This buyer already has a usable license, already bound to a device — nothing new was created."
        : "This buyer already has a usable, unclaimed license — nothing new was created. Claim (bind) it below.",
    });
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

// Confirmed live (2026-09-19) — this used to REQUIRE ?email=..., 400ing
// otherwise. That meant an admin had no way to see who recently got a
// license (issued, self-service auto-bound, or claimed) without already
// knowing their email — a real "user goes missing from admin" gap, not just
// an inconvenience. Now: no email -> the 100 most recent licenses across
// EVERY buyer (mirrors Vantra's admin exe-licenses page, same shape), so a
// freshly issued or bound license always surfaces here immediately, live off
// the same table every action already writes to. Email still narrows to one
// buyer's licenses, unchanged, for the claim/transfer/unbind actions below.
export async function GET(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const email = new URL(req.url).searchParams.get("email")?.trim() ?? "";

  let userId: string | undefined;
  if (email) {
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
    }
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      return NextResponse.json({ licenses: [] });
    }
    userId = user.id;
  }

  const licenses = await prisma.exeLicense.findMany({
    where: userId ? { userId } : {},
    orderBy: { issuedAt: "desc" },
    take: 100,
    include: { user: { select: { email: true } } },
  });

  return NextResponse.json({
    licenses: licenses.map((l) => ({
      id: l.id,
      email: l.user.email,
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