import { NextResponse } from "next/server";

import { exeLicenseSecret, decodeLicenseKey } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
import { getMachineId } from "@/lib/machine-id";
import { getProduct } from "@/lib/products";
import { saveActivation } from "@/lib/license-state";

// POST /api/exe-license/activate — body: { licenseKey, email }
//
// The shared <LicenseGate>'s "Activate" handler, running inside the desktop
// EXE's local runtime. Validates the key against the embedded signing secret
// (no server round-trip needed for that part), checks the emailed `licensee`
// against the key's payload, then persists the activation locally. Gated by
// isLocalExeRuntime() (see lib/exe-runtime.ts) — fail-closed, never reachable
// on the deployed web server.
//
// Self-service redesign (2026-09-19) — a purchase-reference (UNBOUND) key used
// to be rejected outright here, requiring a separate trip to the Licenses page
// to claim it first. That's real friction for zero extra security: this route
// still ONLY calls the hosted /api/exe-license/auto-bind endpoint when the key
// is genuinely valid AND its licensee matches the submitted email — the exact
// same trust bar the old manual claim required, just without the extra step.
// bindExeLicenseToMachine's one-machine-per-license invariant (first
// activation wins, "already active on another device" for every attempt
// after) is completely unchanged — this only removes the SEPARATE step, not
// the guarantee. An already-bound key (someone else already activated first,
// or it was claimed via the admin/self-service page) still validates fully
// offline as before — the network call only happens for a fresh, never-bound
// key's FIRST activation.
export async function POST(req: Request) {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { licenseKey?: unknown; email?: unknown; transferCode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const transferCode = typeof body.transferCode === "string" ? body.transferCode.trim() : undefined;
  if (!licenseKey) {
    return NextResponse.json({ error: "Enter your license key." }, { status: 400 });
  }
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter the email you purchased with." }, { status: 400 });
  }

  let secret: string;
  try {
    secret = exeLicenseSecret();
  } catch {
    return NextResponse.json(
      { error: "Licensing is not configured on this device." },
      { status: 500 },
    );
  }

  const currentMachineId = (await getMachineId()).toLowerCase();
  const validation = await validateLicenseKey(licenseKey, secret, {
    currentMachineId,
  });

  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Per-tool enforcement: a license is cryptographically signed for ONE
  // SpaceWorker EXE variant (payload.product). Reject it here if that isn't
  // the build currently running — checked BEFORE any auto-bind attempt, so a
  // key minted for the wrong tool never gets bound to a machine at all.
  // Fail-closed: a legacy key carrying no product field also lands here.
  const expectedProduct = `${exeBuildTarget()}_exe`;
  if (!validation.product || validation.product !== expectedProduct) {
    const forName = getProduct(validation.product)?.name ?? "another SpaceWorker tool";
    const currentName = getProduct(expectedProduct)?.name ?? "this SpaceWorker tool";
    return NextResponse.json(
      {
        error: `This license is for ${forName} — it belongs to a different SpaceWorker tool and can't be activated in ${currentName}. Buy the right product, or contact us if you made a mistake.`,
      },
      { status: 400 },
    );
  }

  // Light anti-sharing check: the email entered must match the key's licensee
  // (Part A — "does this key belong to the account this person is typing", a
  // usability/anti-sharing check, not a security boundary).
  if (email.toLowerCase() !== validation.licensee.trim().toLowerCase()) {
    return NextResponse.json(
      { error: "This key belongs to a different email. Use the address it was purchased with." },
      { status: 400 },
    );
  }

  const decoded = decodeLicenseKey(licenseKey);
  const hasMachineBinding = !!decoded?.machine_id || (decoded?.machine_ids?.length ?? 0) > 0;

  let activationKey = licenseKey;
  if (!hasMachineBinding) {
    // First activation of a fresh purchase-reference key — bind it to THIS
    // machine now, server-side, instead of sending the buyer to claim it
    // manually first. One network call; everything else on this route stays
    // fully offline.
    let res: Response;
    try {
      res = await fetch(`${HOSTED_APP_URL}/api/exe-license/auto-bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey, email, machineId: currentMachineId, transferCode }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return NextResponse.json(
        { error: "Couldn't reach the license server to activate this device. Check your connection and try again." },
        { status: 502 },
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // "already_bound" is not a dead-end error — surface the code so the
      // activation form can offer an explicit "move it here" confirmation
      // instead of just failing (see auto-bind's file-top comment).
      return NextResponse.json(
        {
          error: typeof data.error === "string" ? data.error : "Couldn't activate this license.",
          code: typeof data.code === "string" ? data.code : undefined,
        },
        { status: res.status },
      );
    }
    if (typeof data.boundLicenseKey !== "string" || !data.boundLicenseKey) {
      return NextResponse.json({ error: "Activation server returned an unexpected response." }, { status: 502 });
    }
    activationKey = data.boundLicenseKey;
  }

  const state = await saveActivation({
    licensee: email,
    licenseKey: activationKey,
    machineId: currentMachineId,
  });

  return NextResponse.json({
    licensed: true,
    licensee: validation.licensee,
    plan: validation.plan,
    product: validation.product,
    expiresAt: validation.expiresAt,
    expiresAtDate: validation.expiresAtDate?.toISOString(),
    activatedAt: state.activation?.activatedAt,
  });
}
