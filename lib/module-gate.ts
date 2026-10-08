import { NextResponse } from "next/server";

import "server-only";

import { hasEntitlement, type EntitlementKey } from "./entitlements";

/**
 * TASK_184 Phase A2 — THE module gate for web tool surfaces, in one place.
 *
 * Free (tier 1) accounts and tier-3 XDevice accounts can BROWSE the app —
 * they may open extractor / cyberlabs / hosting pages and see the product —
 * but every WRITE/DOING route inside those modules requires the module's own
 * entitlement: a tier-5 premium term, a grant row, or an `xdevice` grant for
 * `devices` (which this gate deliberately does not cover — see
 * device-gate.ts for device actions).
 *
 * Key rule (Phase C): entitlement KEY, never the tier number. Tier 3 is
 * `devices`-only; tier 5 (premium) covers every key via hasEntitlement.
 *
 * Usage in a route handler, right after the session check:
 *
 *   const denied = await moduleToolsDenied(session.userId, "extractor");
 *   if (denied) return denied;
 *
 * Returns null when allowed (happy path reads as a no-op), or a ready 403
 * `{ error: "extractor_required" }`. NEVER use on pure READ/list routes the
 * UI needs to render the locked state (prices, preview), and NEVER on
 * AGENT-FACING routes. The dashboard PAGES stay visible — the lock card is
 * what free users see there (A3).
 */
const MODULE_CODES: Record<EntitlementKey, string> = {
  extractor: "extractor_required",
  mailer: "mailer_required",
  assistant: "assistant_required",
  devices: "xdevice_required",
  cyberlab: "cyberlab_required",
  hosting: "hosting_required",
};

export async function moduleToolsDenied(
  userId: string,
  key: EntitlementKey
): Promise<NextResponse | null> {
  const decision = await hasEntitlement(userId, key);
  if (decision.allowed) return null;
  return NextResponse.json({ error: MODULE_CODES[key] }, { status: 403 });
}
