import { NextResponse } from "next/server";

import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { getMachineId } from "@/lib/machine-id";
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
    expiresAt: validation.expiresAt,
    expiresAtDate: validation.expiresAtDate?.toISOString(),
    activatedAt: state.activation?.activatedAt,
  });
}