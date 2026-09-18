import { NextResponse } from "next/server";

import { exeLicenseSecret, decodeLicenseKey } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { getMachineId } from "@/lib/machine-id";
import { getProduct } from "@/lib/products";
import { saveActivation } from "@/lib/license-state";

// POST /api/exe-license/activate — body: { licenseKey, email }
//
// The shared <LicenseGate>'s "Activate" handler. Runs FULLY offline inside the
// desktop EXE's local runtime: it validates the key against the embedded signing
// secret (no server round-trip), checks the emailed `licensee` against the key's
// payload (the light anti-sharing/usability check Part A specifies), then binds
// the CURRENT machine id and persists the activation locally. Gated by
// isLocalExeRuntime() (see lib/exe-runtime.ts) — fail-closed, never reachable on
// the deployed web server.
export async function POST(req: Request) {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { licenseKey?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
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

  // Task 47 — the actual vulnerability this task exists to close. The key that a
  // checkout issues is UNBOUND (no machine binding) — a purchase reference, not
  // something the EXE may accept. Without this check, that unbound key validated
  // on ANY machine (the offline validator's machine check is a no-op when
  // machine_id/machine_ids are both absent), i.e. one purchase = unlimited
  // machines. Reject it here with a clear remediation message; the buyer's real
  // activation key is the RE-SIGNED, machine-bound key produced by claiming this
  // license on their account's Licenses page (admin tool or self-service).
  const decoded = decodeLicenseKey(licenseKey);
  const hasMachineBinding = !!decoded?.machine_id || (decoded?.machine_ids?.length ?? 0) > 0;
  if (!decoded || !hasMachineBinding) {
    return NextResponse.json(
      {
        error:
          "This key is a purchase reference, not an activation key — claim your license to this device on your account's Licenses page first, and use the activation key it gives you.",
      },
      { status: 400 },
    );
  }

  // Per-tool enforcement (the gap this task closes): a license is cryptographically
  // signed for ONE SpaceWorker EXE variant (payload.product). Reject it here if that
  // isn't the build currently running — so a key minted for the Extractor can never
  // activate inside, say, the Mailer, even if its DB row says otherwise. Fail-closed:
  // a legacy key carrying no product field also lands here. The build's own tool comes
  // from BUILD_TARGET (lib/exe-build-target.ts), mapped to its ProductId.
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

  const state = await saveActivation({
    licensee: email,
    licenseKey,
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