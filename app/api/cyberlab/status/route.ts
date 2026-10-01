import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C1 (scaffolding) — GET /api/cyberlab/status.
//
// The Cyber Lab tab and its dashboard card land now (owner, 2026-10-01: "the
// cyberlab and workers should be added to the menu and dashboard cards"), but
// the engine itself is C1/C2 work in PLAN_TASK_156 §7. This route is the single
// honest "what is the lab allowed to do right now" read, mirroring
// /api/hosting/status's shape so the two tabs behave alike:
//
//   enabled   = AdminSetting.cyberlabEnabled (the master switch, OFF by
//               default — the lab is dark until C2 ships).
//   entitled  = the per-user `cyberlab` entitlement (already present in
//               ENTITLEMENT_KEYS).
//   caps      = the admin dials (CROSS-TRACK RULE 7). They are read but not yet
//               enforced anywhere, because nothing runs yet; they exist so the
//               owner can set the load envelope before the heavy tooling lands.
//
// No lab model is touched here — it is a pure settings read, so this route is
// safe to ship while the lab is unbuilt.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [settings, decision] = await Promise.all([getAdminSettings(), hasEntitlement(user.id, "cyberlab")]);

  return NextResponse.json({
    enabled: settings.cyberlabEnabled,
    entitled: decision.allowed,
    entitlementReason: decision.reason,
    caps: {
      freeMaxConcurrentRanges: settings.cyberlabFreeMaxConcurrentRanges,
      freeMaxRangeMinutes: settings.cyberlabFreeMaxRangeMinutes,
      rangeRamMb: settings.cyberlabRangeRamMb,
      hostRamBudgetMb: settings.cyberlabHostRamBudgetMb,
      maxTargetsPerScenario: settings.cyberlabMaxTargetsPerScenario,
      maxEpisodesPerMonth: settings.cyberlabMaxEpisodesPerMonth,
    },
  });
}
