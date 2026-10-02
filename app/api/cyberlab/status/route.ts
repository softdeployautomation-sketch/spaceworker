import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { cyberLabGate } from "@/lib/lab/gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C1 — GET /api/cyberlab/status.
//
// The Cyber Lab tab's single "what is the lab allowed to do right now" read, now
// carrying the REAL C1 gate (§12.9) instead of the C1-scaffolding settings echo.
// Always 200 for an authenticated user so the tab renders an honest state
// (entitlement prompt / consent prompt / live) rather than an error:
//
//   gate.enabled      = AdminSetting.cyberlabEnabled — platform master switch (OFF
//                       by default; the lab is dark until C2 ships).
//   gate.entitled     = the PREMIUM `cyberlab` entitlement (§12.9 — the ONE door;
//                       there is no staff badge). A non-entitled user is refused
//                       server-side by the gate helper, whatever the client renders.
//   gate.consented    = the C0 AUP gate: a LabConsent row for the CURRENT
//                       termsVersion. Bumping the admin dial forces re-acceptance.
//   gate.open         = enabled && entitled && consented — the single boolean the
//                       UI hangs on.
//   caps              = the admin dials (CROSS-TRACK RULE 7). Read here; nothing
//                       runs yet, so nothing enforces them — they exist so the owner
//                       can set the load envelope before the heavy tooling lands.
//
// The AUP TEXT itself is NOT returned here: the panel imports it from the shared,
// pure lib/lab/aup.ts, so the wording a user reads and the wording that is hashed
// into their consent row can never drift.

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [settings, gate] = await Promise.all([getAdminSettings(), cyberLabGate(user.id)]);

  return NextResponse.json({
    // Kept top-level for the C1-scaffolding consumers (nav/card) that read it.
    enabled: gate.enabled,
    entitled: gate.entitled,
    entitlementReason: gate.entitlementReason,
    gate: {
      open: gate.open,
      termsVersion: gate.termsVersion,
      consented: gate.consented,
      consentedAt: gate.consent?.signedAt ?? null,
    },
    caps: {
      freeMaxConcurrentRanges: settings.cyberlabFreeMaxConcurrentRanges,
      freeMaxRangeMinutes: settings.cyberlabFreeMaxRangeMinutes,
      rangeRamMb: settings.cyberlabRangeRamMb,
      hostRamBudgetMb: settings.cyberlabHostRamBudgetMb,
      maxTargetsPerScenario: settings.cyberlabMaxTargetsPerScenario,
      maxEpisodesPerMonth: settings.cyberlabMaxEpisodesPerMonth,
      // TASK_156 C1 — the §12 sentinel/research dials, surfaced so the panel shows
      // the full envelope from day one.
      maxTargetsPerUser: settings.cyberlabMaxTargetsPerUser,
      maxRunsPerDay: settings.cyberlabMaxRunsPerDay,
      toolStaleAfterDays: settings.cyberlabToolStaleAfterDays,
      researchRefreshDays: settings.cyberlabResearchRefreshDays,
    },
  });
}
