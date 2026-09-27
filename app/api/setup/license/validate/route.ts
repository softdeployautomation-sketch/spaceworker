import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { isSelfHosted } from "@/lib/exe-build-target";
import { getCachedMachineId } from "@/lib/license-state";
import { readSetupState, updateSetupState } from "@/lib/self-hosted-setup-state";

// POST /api/setup/license/validate — body: { licenseKey }
//
// TASK_130 §3. The wizard's mandatory first step. Runs the existing offline
// validator (lib/exe-license-validator.ts, unchanged) against the submitted
// key using EXE_LICENSE_SECRET, and records the successful activation in the
// local setup-state file. Returns the validator's own result — the raw secret
// and the raw signing key are never echoed back.
//
// Guards, in order (TASK_129's discipline):
//   - 404 unless this is a self-hosted build (our own hosted SaaS must never
//     expose /setup at all).
//   - 403 if setup is already complete AND the caller has no admin session —
//     stops an unauthenticated visitor re-running setup on a live instance.
//   - 400 for a malformed/empty key; 200 with { valid:false, error } for a key
//     the validator rejects (that's a result, not a transport failure).
//   - 500 when EXE_LICENSE_SECRET isn't set (licensing not configured on the
//     box) — same message posture as the existing activate route.
export async function POST(req: Request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const state = await readSetupState();
  if (state.completedAt && !(await getAdminSession())) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  let body: { licenseKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const licenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  if (!licenseKey) {
    return NextResponse.json({ error: "Enter your license key." }, { status: 400 });
  }

  let secret: string;
  try {
    secret = exeLicenseSecret();
  } catch {
    return NextResponse.json(
      { error: "Licensing is not configured on the server (EXE_LICENSE_SECRET unset)." },
      { status: 500 },
    );
  }

  // The validator only derives a machine id when the key is actually
  // machine-bound — passing this install's own id explicitly keeps that
  // derivation out of the validator's on-demand path and makes the route
  // deterministic. A key with no machine binding ignores it entirely.
  const currentMachineId = (await getCachedMachineId()).toLowerCase();
  const validation = await validateLicenseKey(licenseKey, secret, { currentMachineId });

  if (!validation.valid) {
    // The validator's own error string, verbatim (TASK_130 §2 step 1).
    return NextResponse.json({ valid: false, error: validation.error });
  }

  await updateSetupState({
    license: { key: licenseKey, validatedAt: new Date().toISOString() },
  });

  return NextResponse.json({
    valid: true,
    licensee: validation.licensee,
    plan: validation.plan,
    product: validation.product,
    issuedAt: validation.issuedAt,
    expiresAt: validation.expiresAt,
  });
}
