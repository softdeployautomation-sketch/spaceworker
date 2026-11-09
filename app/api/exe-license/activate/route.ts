import { NextResponse } from "next/server";

import { exeLicenseSecret, decodeLicenseKey } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { hostedFetch, MAX_MAINTENANCE_RETRIES } from "@/lib/hosted-fetch";
import { getCachedMachineId } from "@/lib/license-state";
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

  const currentMachineId = (await getCachedMachineId()).toLowerCase();

  // Decode the payload WITHOUT verifying the signature — we need the product
  // and licensee for the cheap, offline rejections below, and (critically) we
  // must not let an offline signature check gate the activation of a key that
  // was legitimately issued by the hosted server. See the big comment below.
  const decoded = decodeLicenseKey(licenseKey);
  if (!decoded) {
    return NextResponse.json({ error: "That doesn't look like a valid license key." }, { status: 400 });
  }
  const hasMachineBinding = !!decoded.machine_id || (decoded.machine_ids?.length ?? 0) > 0;

  // Offline signature check — used ONLY for an already-bound key, where there
  // is no server round-trip to make. For a FRESH (unbound) key we deliberately
  // SKIP it and go straight to the hosted auto-bind below.
  //
  // WHY (the bug this fixes): the offline check uses the EXE_LICENSE_SECRET
  // BAKED INTO THE EXE AT CI BUILD TIME, while a key bought/minted on the hosted
  // site is signed with the PRODUCTION secret. When those two ever drift (which
  // they have — that is exactly why a legitimately-purchased mailer key showed
  // "Invalid license key signature"), the offline check REJECTS a perfectly good
  // key. The hosted auto-bind endpoint re-signs the key with the authoritative
  // production secret anyway, so for a fresh key the offline pre-check adds
  // nothing but a way to be wrong. The hosted server is the single source of
  // truth for fresh activation; the offline check only stays as the fast path
  // for a key that is ALREADY bound (where a network call may not be possible).
  if (hasMachineBinding) {
    const validation = await validateLicenseKey(licenseKey, secret, { currentMachineId });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  // Per-tool enforcement: a license is cryptographically signed for ONE
  // SpaceWorker EXE variant (payload.product). Reject it here if that isn't
  // the build currently running — checked BEFORE any auto-bind attempt, so a
  // key minted for the wrong tool never gets bound to a machine at all.
  // Fail-closed: a legacy key carrying no product field also lands here.
  // Read straight from the decoded payload so it does not depend on the
  // (possibly-drifted) offline signature check above.
  const expectedProduct = `${exeBuildTarget()}_exe`;
  if (!decoded.product || decoded.product !== expectedProduct) {
    const forName = getProduct(decoded.product)?.name ?? "another SpaceWorker tool";
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
  // usability/anti-sharing check, not a security boundary). Read from the
  // decoded payload (same reason as the product check above).
  if (email.toLowerCase() !== String(decoded.licensee ?? "").trim().toLowerCase()) {
    return NextResponse.json(
      { error: "This key belongs to a different email. Use the address it was purchased with." },
      { status: 400 },
    );
  }

  let activationKey = licenseKey;
  if (!hasMachineBinding) {
    // First activation of a fresh purchase-reference key — bind it to THIS
    // machine now, server-side. The hosted auto-bind re-verifies the signature
    // with the AUTHORITATIVE production secret (not the EXE's baked-in one) and
    // returns a freshly re-signed, machine-bound key. One network call;
    // everything after this on the route stays fully offline.
    const { response: res } = await hostedFetch(
        "/api/exe-license/auto-bind",
        {
          method: "POST",
          body: JSON.stringify({ licenseKey, email, machineId: currentMachineId, transferCode }),
        },
        { maxRetries: MAX_MAINTENANCE_RETRIES, timeoutMs: 15_000 },
      );
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

  // Report the term from the key we ACTUALLY stored. For a fresh key that key
  // is the freshly re-signed, machine-bound one returned by auto-bind (which
  // preserves the ORIGINAL expiry, so binding never extends the term); for an
  // already-bound key it's the key as entered. Decode it rather than reusing the
  // offline `validation` (which no longer exists here — see the fast-path note
  // above) so the echoed fields always match what's persisted.
  const stored = decodeLicenseKey(activationKey);
  const storedExpiry = stored?.expires_at ? new Date(stored.expires_at) : null;

  return NextResponse.json({
    licensed: true,
    licensee: email,
    plan: stored?.plan ?? "",
    product: stored?.product ?? "",
    expiresAt: stored?.expires_at ?? "",
    expiresAtDate:
      storedExpiry && !Number.isNaN(storedExpiry.getTime()) ? storedExpiry.toISOString() : undefined,
    activatedAt: state.activation?.activatedAt,
  });
}
