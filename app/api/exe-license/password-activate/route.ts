import { NextResponse } from "next/server";

import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { getMachineId } from "@/lib/machine-id";
import { saveActivation } from "@/lib/license-state";

// POST /api/exe-license/password-activate — body: { email, password, confirmTransfer? }
//
// Owner-requested 2026-09-20: an alternative to pasting a license key —
// "make exe sign in optional to use either the password or license". Runs
// inside the desktop EXE's local runtime exactly like /api/exe-license/
// activate, but instead of validating a pasted key offline, it calls the
// hosted /api/exe-license/password-login with the account's email + password
// (password verification can only ever happen server-side against the real
// passwordHash — there is no offline equivalent, so unlike a normal key
// activation this path always needs a network round-trip, same as an
// unbound key's first activation already does). On success it receives the
// SAME kind of bound, signed key the license-key path would end up with and
// saves it locally the same way — from then on this device validates fully
// offline, indistinguishable from having typed the key in directly.
//
// Gated by isLocalExeRuntime() exactly like every other /api/exe/* route.
export async function POST(req: Request) {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { email?: unknown; password?: unknown; confirmTransfer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmTransfer = body.confirmTransfer === true;
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Enter your email." }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ error: "Enter your password." }, { status: 400 });
  }

  const currentMachineId = (await getMachineId()).toLowerCase();
  const product = `${exeBuildTarget()}_exe`;

  let res: Response;
  try {
    res = await fetch(`${HOSTED_APP_URL}/api/exe-license/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, product, machineId: currentMachineId, confirmTransfer }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the license server to sign in. Check your connection and try again." },
      { status: 502 },
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      {
        error: typeof data.error === "string" ? data.error : "Couldn't sign in.",
        code: typeof data.code === "string" ? data.code : undefined,
      },
      { status: res.status },
    );
  }
  if (typeof data.boundLicenseKey !== "string" || !data.boundLicenseKey) {
    return NextResponse.json({ error: "Sign-in server returned an unexpected response." }, { status: 502 });
  }

  const state = await saveActivation({
    licensee: email,
    licenseKey: data.boundLicenseKey,
    machineId: currentMachineId,
  });

  return NextResponse.json({
    licensed: true,
    licensee: email,
    activatedAt: state.activation?.activatedAt,
  });
}
