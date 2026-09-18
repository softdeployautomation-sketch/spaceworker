import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bindExeLicenseToMachine, LicenseBindError } from "@/lib/exe-license-bind";

// POST /api/exe-license/bind — buyer self-service: claim one of their own
// UNBOUND licenses to a single device. Body: { exeLicenseId, machineId, machineLabel? }
//
// Ownership is the ONLY gate (per Task 47): only a signed-in buyer who owns the
// ExeLicense row can claim it. Both a full session and a narrow license_only
// session carry `sub` = the buyer's user id, so an EXE-only buyer who came in via
// the emailed claim link can claim here too.
//
// Deliberately NOT a "re-bind": once a license is bound to a machine it can't be
// silently re-bound here. Moving to a new machine is the admin tool / support
// path, not self-service — that's the DRM hole this whole task closes.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: { exeLicenseId?: unknown; machineId?: unknown; machineLabel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const exeLicenseId = typeof body.exeLicenseId === "string" ? body.exeLicenseId.trim() : "";
  const machineId = typeof body.machineId === "string" ? body.machineId.trim() : "";
  const machineLabel =
    typeof body.machineLabel === "string" && body.machineLabel.trim()
      ? body.machineLabel.trim()
      : null;

  if (!exeLicenseId) {
    return NextResponse.json({ error: "Pick a license to claim." }, { status: 400 });
  }

  // Ownership gate — the license must belong to the signed-in buyer.
  const license = await prisma.exeLicense.findUnique({ where: { id: exeLicenseId } });
  if (!license || license.userId !== session.sub) {
    // Fail-closed + opaque: don't reveal whether the id exists.
    return NextResponse.json(
      { error: "That license doesn't belong to this account." },
      { status: 404 },
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
      product: bound.product,
      productName: bound.productName,
      expiresAt: bound.expiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof LicenseBindError) {
      const status = err.code === "already_bound" ? 409 : err.code === "not_found" ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}