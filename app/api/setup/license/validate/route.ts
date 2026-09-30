import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { exeLicenseSecret, isLifetimeExpiry } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { isSelfHosted } from "@/lib/exe-build-target";
import { getCachedMachineId } from "@/lib/license-state";
import { getProduct, SELF_HOSTED_OS } from "@/lib/products";
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
//     the validator rejects (that's a result, not a transport failure), and the
//     same shape for a key signed for a different product (TASK_145 / T9) —
//     only a `selfhosted_os` key may activate a self-hosted install.
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

  // TASK_145 (T9) — the wizard must only ever accept a key signed for the
  // self-hosted product. This route goes straight to the raw offline
  // validator, which has no build-target product check of its own (unlike
  // app/api/exe-license/activate/route.ts:80-90), so without this an EXE key
  // bought from the public store would activate a self-hosted install.
  // A product mismatch is an answer, not a transport failure, so it uses the
  // same `{ valid: false, error }` shape as a validator rejection — the key is
  // NOT recorded in setup state. Fail-closed: a legacy key carrying no
  // `product` field lands here too.
  if (validation.product !== SELF_HOSTED_OS.id) {
    const forName = getProduct(validation.product)?.name ?? "another SpaceWorker tool";
    return NextResponse.json({
      valid: false,
      error: `This license is for ${forName}, not ${SELF_HOSTED_OS.name}. Enter a self-hosted license key, or contact us if you made a mistake.`,
    });
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
    // TASK_145 (T9) — "lifetime" is decided ONLY from the decoded `expires_at`
    // (the year-2999 sentinel), never a client flag, a DB column or a day
    // count. The client never re-parses dates itself.
    lifetime: isLifetimeExpiry(validation.expiresAtDate),
  });
}
