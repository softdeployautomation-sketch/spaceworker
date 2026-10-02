import "server-only";

import { getAdminSettings } from "@/lib/admin-settings";
import { hasEntitlement, type EntitlementDecision } from "@/lib/entitlements";

import { currentConsent, type ConsentRow } from "./consent";

// TASK_156 C1 — THE Cyber Lab gate (§12.9 BINDING).
//
// The owner's ruling: the lab is gated by the PREMIUM `cyberlab` ENTITLEMENT, and
// there is NO staff badge and NO staff-role gate in SpaceWorker (only Vantra ever
// had a "staff track"). So this is the ONE door:
//
//   enabled  = AdminSetting.cyberlabEnabled — the platform master switch. OFF by
//              default; the lab is dark until C2 ships. A non-entitled user is
//              refused server-side regardless (§12.9), but while `enabled` is false
//              even an entitled user sees "not switched on yet".
//   entitled = the per-user `cyberlab` entitlement (premium tier 5 passes it, or a
//              UserEntitlement grant of key `cyberlab`). This is the premium gate.
//   consent  = the C0 AUP gate: the user must have accepted the CURRENT
//              termsVersion. A new AdminSetting.cyberlabConsentTermsVersion forces
//              re-acceptance (consent is recorded per version).
//
// Reuse, never duplicate (CROSS-TRACK RULE 5): the entitlement decision comes from
// lib/entitlements.hasEntitlement — the same gate hosting uses — not a private copy.
//
// HONEST LIMIT (§12.9): this is AUTHORIZATION HYGIENE, not a legal fence. It does
// not replace the C0 AUP/consent, the §5.2 abuse sentinel, or the C6 L4 work.

export interface CyberLabGate {
  /** Platform master switch (AdminSetting.cyberlabEnabled). */
  enabled: boolean;
  /** Whether the caller holds the premium `cyberlab` entitlement. */
  entitled: boolean;
  /** The entitlement decision reason ("premium" | "grant" | "none" | "expired"). */
  entitlementReason: EntitlementDecision["reason"];
  /** The AUP version the gate currently enforces. */
  termsVersion: string;
  /** Whether the caller has a consent row for `termsVersion`. */
  consented: boolean;
  /** The consent row in force, if any (for the UI's "accepted on <date>"). */
  consent: ConsentRow | null;
  /**
   * The single boolean the UI hangs on: the lab is usable by this caller when it is
   * switched on, they hold the entitlement, and they have accepted the current AUP.
   */
  open: boolean;
}

export async function cyberLabGate(userId: string): Promise<CyberLabGate> {
  const settings = await getAdminSettings();
  const termsVersion = settings.cyberlabConsentTermsVersion;

  const [decision, consent] = await Promise.all([
    hasEntitlement(userId, "cyberlab"),
    currentConsent(userId, termsVersion),
  ]);

  const enabled = settings.cyberlabEnabled;
  const entitled = decision.allowed;
  const consented = consent !== null;

  return {
    enabled,
    entitled,
    entitlementReason: decision.reason,
    termsVersion,
    consented,
    consent,
    open: enabled && entitled && consented,
  };
}
