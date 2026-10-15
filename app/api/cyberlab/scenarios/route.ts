import { NextResponse } from "next/server";

import { getAdminSettings } from "@/lib/admin-settings";
import { ensureLiveEgressScenario, ensureReconScenario, ensureSmokeScenario, getEnabledScenarios } from "@/lib/lab/scenarios";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C2a (PLAN_TASK_156 §7 C2, §12.8) — the scenario allow-list API.
// The engine and the UI read the SAME rows (getEnabledScenarios) — there is no
// second copy of the allow-list anywhere. The smoke row is self-healing
// (idempotent upsert) so a fresh environment always has exactly one runnable
// dry-run scenario. TASK_156B Slice 2 — the recon (scan-first) row is ensured
// the same way, so scan-first recon is always available without an attested
// device (see lib/lab/recon-core.ts). TASK_156B REAL EGRESS — the live row is
// ensured but bound to the ship-dark master dial (it only appears when
// cyberlabLiveEgressEnabled is on), and its reported `mode` is honest: "live".

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const settings = await getAdminSettings();
  await ensureSmokeScenario();
  await ensureReconScenario();
  await ensureLiveEgressScenario();
  const scenarios = await getEnabledScenarios();
  return NextResponse.json({
    scenarios: scenarios.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      klass: s.klass,
      techniqueIds: s.techniqueIds,
      blastRadius: s.blastRadius,
      cleanup: s.cleanup,
      author: s.author,
      // Honest per-row mode: a `live` row sends real packets; everything else is
      // a dry-run. `liveEgressEnabled` is surfaced so the UI can explain WHY the
      // live scenario is (or is not) present without a second settings call.
      mode: s.klass === "live" ? "live" : "dry-run",
    })),
    liveEgressEnabled: settings.cyberlabLiveEgressEnabled === true,
  });
}
