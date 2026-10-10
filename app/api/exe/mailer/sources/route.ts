import { NextResponse } from "next/server";

import { isLocalExeRuntime } from "@/lib/exe-runtime";
import { hostedFetch, MAX_MAINTENANCE_RETRIES } from "@/lib/hosted-fetch";
import { getCachedMachineId, readLocalState } from "@/lib/license-state";
import { exeLicenseSecret } from "@/lib/exe-license";
import { validateLicenseKey } from "@/lib/exe-license-validator";
import { exeBuildTarget } from "@/lib/exe-build-target";

// TASK_201 S2 — GET /api/exe/mailer/sources, the LOCAL half of the Mailer
// EXE's sources fetch (mailboxes with decrypted passwords + sending domains +
// templates). Gated by isLocalExeRuntime() like every /api/exe/* route: 404
// fail-closed on the hosted web app.
//
// This runtime has neither a DATABASE_URL nor MAILBOX_ENCRYPTION_KEY, so the
// route never touches data itself — it proves THIS device is activated (the
// activation the user completed through /api/exe-license/activate), re-validates
// the stored key offline exactly like /api/exe-license/status does, then proxies
// the machine's own identifiers to the hosted /api/exe-license/mailer-sources
// (which does the querying + decryption after its own three-layer check; see
// that route's header). HostedFetch rides out the deploy/maintenance window so
// a VPS restart mid-refresh reads as a friendly retry instead of an error.
export async function GET() {
  if (!isLocalExeRuntime()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const state = await readLocalState();
  const activation = state.activation;
  if (!activation) {
    // No key on this device — the LicenseGate is the only UI that can appear
    // before activation, so this is a defensive miss, not a user path.
    return NextResponse.json({ error: "Activate your license first." }, { status: 401 });
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
  const machineId = (await getCachedMachineId()).toLowerCase();
  // Fail CLOSED offline (unlike status's revocation poll, which fails open on
  // purpose): this call hands back plaintext SMTP passwords, so an expired or
  // machine-mismatched key must never pass just because we are offline.
  const validation = await validateLicenseKey(activation.licenseKey, secret, {
    currentMachineId: machineId,
  });
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 403 });
  }

  const { response: res } = await hostedFetch(
    "/api/exe-license/mailer-sources",
    {
      method: "POST",
      body: JSON.stringify({
        email: activation.licensee,
        licenseKey: activation.licenseKey,
        product: `${exeBuildTarget()}_exe`,
        machineId,
      }),
    },
    { maxRetries: MAX_MAINTENANCE_RETRIES, timeoutMs: 15_000 },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: typeof data.error === "string" ? data.error : "Couldn't load your sending sources." },
      { status: res.status },
    );
  }
  return NextResponse.json(data);
}
