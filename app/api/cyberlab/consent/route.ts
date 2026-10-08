import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { moduleToolsDenied } from "@/lib/module-gate";
import { clientIp, recordConsent } from "@/lib/lab/consent";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C1 (PLAN_TASK_156 §7 C0) — POST /api/cyberlab/consent.
//
// Records the user's acceptance of the CURRENT Cyber Lab AUP into `LabConsent`
// (append-only). This is the C0 gate: until a consent row exists for the current
// termsVersion, the lab is not `open` (lib/lab/gate.ts).
//
// GATING: acceptance requires the PREMIUM `cyberlab` entitlement (§12.9) — a user
// who cannot use the lab is not asked to sign its AUP. The master switch does NOT
// block acceptance (a user may accept the terms while the lab is still dark, so the
// C2 go-live needs no second action) — but the entitlement does.
//
// Idempotent: accepting twice returns the existing row with created=false; the row
// is never rewritten (§5.2.6). The current termsVersion comes from AdminSetting, so
// the hash the user signs is always the version the gate will next check.

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const settings = await getAdminSettings();
  const { row, created } = await recordConsent({
    userId: user.id,
    termsVersion: settings.cyberlabConsentTermsVersion,
    ip: clientIp(req),
  });

  return NextResponse.json({
    ok: true,
    created,
    termsVersion: row.termsVersion,
    signedAt: row.signedAt,
    consentId: row.id,
  });
}
