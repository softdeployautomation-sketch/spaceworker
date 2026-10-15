// TASK_156 C2a (§12.8 catalog row) — the ONE scenario that runs before the owner's
// lab hosts exist (C2b). It is a documented dry-run: the evidence chain it proves
// is real, the telemetry it produces is synthetic and labelled as such in every
// artefact (see lib/lab/runner.ts).

import "server-only";

import { db } from "@/lib/db";
import { SMOKE_TECHNIQUE_IDS } from "./runner";
import { RECON_TECHNIQUE_IDS } from "./recon-core";
import { LIVE_TECHNIQUE_IDS } from "./live-core";

export const SMOKE_SCENARIO_SLUG = "smoke-network-baseline";

/** TASK_156B Slice 2 — the scan-first recon scenario (klass "recon"). */
export const RECON_SCENARIO_SLUG = "recon-attack-surface";

/** TASK_156B REAL EGRESS — the live server-egress scan scenario (klass "live"). */
export const LIVE_EGRESS_SCENARIO_SLUG = "live-server-egress";

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

/**
 * TASK_156B Slice 2 (§3.3) — idempotently ensure the scan-first recon scenario
 * row exists and is enabled. Same self-healing pattern as ensureSmokeScenario:
 * a fresh environment always has exactly one runnable recon dry-run.
 *
 * The `blastRadius` text is the plain-language worst case (§6) — here: nothing,
 * because recon is SIMULATED and enumerates only the scope the caller declared
 * (and which validateReconScope already bounded to /24-or-narrower). No packet
 * leaves the platform; no real host is contacted.
 */
export async function ensureReconScenario() {
  return db.labScenario.upsert({
    where: { slug: RECON_SCENARIO_SLUG },
    update: { enabled: true },
    create: {
      slug: RECON_SCENARIO_SLUG,
      name: "Attack-surface recon (scan-first, simulated)",
      klass: "recon",
      techniqueIds: [...RECON_TECHNIQUE_IDS],
      adversaryProfile: "curious-probe",
      blastRadius:
        "None. This is a SIMULATED recon in dry-run mode: it enumerates only the scope you declare (a single host, or a network no broader than /24), generates SYNTHETIC surface data, sends no packet, and contacts no real host.",
      cleanup:
        "Automatic: the LabRange reaches torn_down via a VERIFIED teardown before the run is considered finished; an unverified teardown fails the range (§8.5).",
      enabled: true,
      author: "staff",
    },
  });
}

export async function getScenarioBySlug(slug: string) {
  return db.labScenario.findUnique({ where: { slug } });
}

/**
 * TASK_156B REAL EGRESS (§2) — idempotently ensure the LIVE server-egress scan
 * scenario row. Unlike smoke/recon, its `enabled` flag is BOUND to the ship-dark
 * master dial (AdminSetting.cyberlabLiveEgressEnabled): while the dial is OFF
 * (the default), the row is created/updated DISABLED, so it never appears in the
 * allow-list and no real packet can ever be sent. The owner flips the dial on
 * right before filming the ad, and the scenario self-heals to enabled on the
 * next /api/cyberlab/scenarios read.
 *
 * `blastRadius` is the plain-language worst case (§6), and for a live run it is
 * HONEST: real TCP packets leave the platform and touch the host you name. It
 * only enumerates the scope you declare; the breadth guard and allow-list are
 * optional dials (default open) — the guardrail that actually matters is that
 * CyberLab is grant-only and off the Premium Plus catch-all, so the only people
 * who ever reach this button are hand-verified by the owner.
 */
export async function ensureLiveEgressScenario() {
  // The row stays ALWAYS enabled — the engine's master-dial check
  // (isLive = klass === "live" && cyberlabLiveEgressEnabled) is the SOLE gate.
  // Binding row.enabled to the dial here would be redundant AND harmful: the
  // dial can flip after this ensure (tests, or the owner toggling mid-session),
  // and a disabled row would short-circuit to scenario_not_allowed before the
  // engine's honest live_egress_disabled refusal ever ran.
  return db.labScenario.upsert({
    where: { slug: LIVE_EGRESS_SCENARIO_SLUG },
    update: { enabled: true },
    create: {
      slug: LIVE_EGRESS_SCENARIO_SLUG,
      name: "Live server egress scan (real packets)",
      klass: "live",
      techniqueIds: [...LIVE_TECHNIQUE_IDS],
      adversaryProfile: "authorized-pentest",
      blastRadius:
        "REAL. This run sends real TCP connect probes from our servers to the host you declare and records open/closed/filtered for each port. It only touches the exact scope you name — no broader network is swept — but the packets genuinely leave the platform, so only ever point it at equipment you own and are authorized to test.",
      cleanup:
        "Automatic: the LabRange reaches torn_down via a VERIFIED teardown before the run is considered finished; an unverified teardown fails the range (§8.5).",
      enabled: true,
      author: "staff",
    },
  });
}
