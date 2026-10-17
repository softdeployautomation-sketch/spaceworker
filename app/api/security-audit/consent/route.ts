import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { deviceToolsDenied } from "@/lib/device-gate";
import { clientIp, consentHash } from "@/lib/lab/consent";
import { db } from "@/lib/db";
import { LAN_AUDIT_CONSENT_SCOPE, lanAuditConsent } from "@/lib/security-audit/run";
import { getCurrentUser } from "@/lib/session-user";

// TASK_217 — POST /api/security-audit/consent.
//
// Records the user's acceptance of the CURRENT terms for the LAN-audit scope
// into the APPEND-ONLY `LabConsent` table (its own scope "lan-audit" — a lab
// AUP consent does not silently grant a device audit). Idempotent per scope:
// an existing lan-audit row is returned with created=false and never rewritten.
//
// GATING: requires the xdevice entitlement (deviceToolsDenied) — an audit runs
// a command on the owner's device, so it is a device tool, not a read.

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await deviceToolsDenied(user.id);
  if (denied) return denied;

  const settings = await getAdminSettings();
  const termsVersion = settings.cyberlabConsentTermsVersion;

  const existing = await lanAuditConsent(user.id);
  if (existing) {
    return NextResponse.json({
      ok: true,
      created: false,
      termsVersion: existing.termsVersion,
      signedAt: existing.signedAt,
      consentId: existing.id,
    });
  }

  const row = await db.labConsent.create({
    data: {
      userId: user.id,
      termsVersion,
      scope: LAN_AUDIT_CONSENT_SCOPE,
      ip: clientIp(req),
      hash: consentHash(user.id, termsVersion),
    },
    select: { id: true, termsVersion: true, signedAt: true },
  });

  return NextResponse.json({
    ok: true,
    created: true,
    termsVersion: row.termsVersion,
    signedAt: row.signedAt,
    consentId: row.id,
  });
}

// GET — consent status only, so the console can label the button honestly
// ("Accept & run" vs "Run audit") without triggering a write.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const existing = await lanAuditConsent(user.id);
  return NextResponse.json({
    ok: true,
    consented: !!existing,
    termsVersion: existing?.termsVersion ?? null,
  });
}

