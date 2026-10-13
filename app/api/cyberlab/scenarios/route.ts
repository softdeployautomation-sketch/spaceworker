import { NextResponse } from "next/server";

import { ensureSmokeScenario, getEnabledScenarios } from "@/lib/lab/scenarios";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C2a (PLAN_TASK_156 §7 C2, §12.8) — the scenario allow-list API.
// The engine and the UI read the SAME rows (getEnabledScenarios) — there is no
// second copy of the allow-list anywhere. The smoke row is self-healing
// (idempotent upsert) so a fresh environment always has exactly one runnable
// dry-run scenario.

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  await ensureSmokeScenario();
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
      // C2a runs dry-run only; live mode is C2b (owner infra).
      mode: "dry-run",
    })),
  });
}
