// TASK_156 C2a (§12.8 catalog row) — the ONE scenario that runs before the owner's
// lab hosts exist (C2b). It is a documented dry-run: the evidence chain it proves
// is real, the telemetry it produces is synthetic and labelled as such in every
// artefact (see lib/lab/runner.ts).

import "server-only";

import { db } from "@/lib/db";
import { SMOKE_TECHNIQUE_IDS } from "./runner";

export const SMOKE_SCENARIO_SLUG = "smoke-network-baseline";

/**
 * Idempotently ensure the smoke scenario row exists and is enabled. The
 * `blastRadius` text is the plain-language worst case (§6: "Plain-language
 * statement of the worst thing this can touch") — here: nothing, because the
 * dry-run touches no real host.
 */
export async function ensureSmokeScenario() {
  return db.labScenario.upsert({
    where: { slug: SMOKE_SCENARIO_SLUG },
    update: { enabled: true },
    create: {
      slug: SMOKE_SCENARIO_SLUG,
      name: "Network smoke baseline (dry-run)",
      klass: "network",
      techniqueIds: [...SMOKE_TECHNIQUE_IDS],
      adversaryProfile: "curious-probe",
      blastRadius:
        "None beyond the attested lab targets. This scenario runs in --dry-run mode: it generates SYNTHETIC telemetry only, no packet leaves the platform, and no real host is contacted.",
      cleanup:
        "Automatic and required: the LabRange must reach torn_down via a VERIFIED teardown before the run is considered finished; an unverified teardown fails the range (§8.5).",
      enabled: true,
      author: "staff",
    },
  });
}

/** The allow-list the UI and the engine both read — never a separate copy. */
export async function getEnabledScenarios() {
  return db.labScenario.findMany({ where: { enabled: true }, orderBy: { klass: "asc" } });
}

export async function getScenarioBySlug(slug: string) {
  return db.labScenario.findUnique({ where: { slug } });
}
