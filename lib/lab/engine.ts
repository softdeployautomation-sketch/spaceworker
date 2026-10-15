// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 4, §8, §5.2) — the run orchestrator.
//
// `startLabRun` is the ONE path that may create a LabRange. Order is the
// playbook's, and every step is a hard gate, not a suggestion:
//   1. cyberLabGate — enabled + premium entitlement + current-AUP consent (§12.9).
//   2. scenario must exist AND be enabled (the allow-list, §6).
//   3. daily run cap (AdminSetting.cyberlabMaxRunsPerDay).
//   4. pre-flight: for an attested scenario, every target must match a FRESH
//      attested LabTarget row; for a recon scenario (Slice 2, scan-first) the
//      caller's declared scope is validated by validateReconScope instead (no
//      attested device required; a too-broad network is refused + audited).
//      Any attested-scenario refusal writes the LabAbuseReport and refuses (§5.2).
//   5. createLabRange(pending) → governor requestSlot("labRanges") →
//      provision → activate with the HARD TTL (cyberlabFreeMaxRangeMinutes).
//   6. dry-run execute: synthetic telemetry, guarded so it can only mention the
//      pre-flight-attested targets (lib/lab/runner.ts).
//   7. createEpisode: signed manifest, append-only row (monthly cap enforced).
//   8. teardown: beginTeardown → completeTeardown(verified). Anything that
//      throws between 5 and 8 lands the range in `failed` with the error — a
//      range NEVER dangles in a live state after the run attempt.
//
// HONEST LIMIT: mode is "dry-run" — the evidence artefacts are SYNTHETIC and
// say so in their own content; nothing here touches a real host. Live
// execution is the owner-infra phase (C2b) and will reuse this same
// gate → preflight → range → episode chain.
//
// Governor wiring: the slot's live-count IS the LabRange state (see the
// labRanges registry entry) — reaching torn_down/failed releases it, so there
// is no separate release call to forget. A queued (not granted) decision is
// refused to the caller with the position; C2a does not block-wait.

import "server-only";

import { requestSlot } from "@/lib/resource-governor";
import { getAdminSettings } from "@/lib/admin-settings";
import { db } from "@/lib/db";

import { cyberLabGate } from "./gate";
import { createEpisode } from "./episode";
import type { EvidenceArtefact } from "./evidence";
import { validateReconScope } from "./recon-core";
import { generateReconTelemetry } from "./recon-runner";
import { activateRange, beginTeardown, completeTeardown, createLabRange, failRange, provisionRange } from "./range";
import { generateSmokeTelemetry, type TimelineEntry } from "./runner";
import { getScenarioBySlug, SMOKE_SCENARIO_SLUG } from "./scenarios";
import { preflightRunTargets, TargetRefusedError, type NormalizedTarget, type PreflightInput } from "./targets";
import { collectVictimSensor } from "./victim-sensor";

/** A run the lab refused, with the machine-readable reason in the message. */
export class LabRunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabRunRefusedError";
  }
}

export interface LabRunResult {
  rangeId: string;
  episodeId: string;
  scenarioSlug: string;
  mode: "dry-run";
  targets: NormalizedTarget[];
  techniques: string[];
  telemetrySignatures: string[];
  timeline: TimelineEntry[];
  /** The artefacts the signed manifest covers (incl. timeline.json). */
  artefacts: EvidenceArtefact[];
  signedHash: string | null;
  verified: boolean;
  /**
   * C2b victim-sensor summary when the run named the user's own devices
   * (null = no victim devices requested / dry-run attack only).
   */
  victim: {
    deviceCount: number;
    window: { from: string; to: string };
    counts: { heartbeats: number; audit: number; jobs: number; actions: number };
  } | null;
}

/**
 * Start (and, in C2a, complete) one dry-run. Synchronous by design: a dry-run
 * has nothing to wait for, so the range is provisioned, executed, evidenced
 * and torn down within the call — the TTL exists for the live phase (C2b).
 */
export async function startLabRun(params: {
  userId: string;
  scenarioSlug?: string;
  targets: PreflightInput[];
  sourceIp?: string | null;
  /**
   * C2b (§13 BYOT) — the user's OWN devices acting as the victim sensor. When
   * given, their agent rows for the run window join the signed evidence. A
   * device this user cannot read is a §5.2 refusal (LabAbuseReport + 403), not
   * a silent skip.
   */
  victimDeviceIds?: string[];
}): Promise<LabRunResult> {
  // 1. The §12.9 door: disabled master switch, missing entitlement or stale
  //    consent all refuse here, server-side, before anything else happens.
  const gate = await cyberLabGate(params.userId);
  if (!gate.open) {
    const why = !gate.enabled ? "disabled" : !gate.entitled ? "not_entitled" : "consent_missing";
    throw new LabRunRefusedError(`lab_gate_closed (${why})`);
  }

  // 2. Allow-listed scenario only.
  const slug = params.scenarioSlug ?? SMOKE_SCENARIO_SLUG;
  const scenario = await getScenarioBySlug(slug);
  if (!scenario || !scenario.enabled) throw new LabRunRefusedError(`scenario_not_allowed (${slug})`);

  // TASK_156B Slice 2 — the scan-first seam. A `recon`-class scenario runs
  // WITHOUT a pre-attested device: the caller declares a scope (validated by
  // validateReconScope) instead of matching a fresh attested LabTarget row.
  // Every other class keeps the attested pre-flight, byte-for-byte unchanged.
  const isRecon = scenario.klass === "recon";

  const settings = await getAdminSettings();
  if (params.targets.length === 0) throw new LabRunRefusedError("no_targets");
  if (params.targets.length > settings.cyberlabMaxTargetsPerScenario) {
    throw new LabRunRefusedError(`too_many_targets (${params.targets.length}/${settings.cyberlabMaxTargetsPerScenario})`);
  }
  // The smoke runner addresses its targets as lab hosts; two host/IP targets
  // are required. (Live scenarios will carry their own target requirements.)
  if (slug === SMOKE_SCENARIO_SLUG && (params.targets.length !== 2 || params.targets.some((t) => t.kind !== "host"))) {
    throw new LabRunRefusedError("smoke_scenario_needs_two_host_targets");
  }

  // 3. Daily run cap (counts every range this user started today).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const runsToday = await db.labRange.count({ where: { userId: params.userId, createdAt: { gte: dayStart } } });
  if (runsToday >= settings.cyberlabMaxRunsPerDay) {
    throw new LabRunRefusedError(`daily_run_cap (${runsToday}/${settings.cyberlabMaxRunsPerDay})`);
  }

  // 5a. The range row first — the governor slot and the pre-flight audit both
  //     hang off its id.
  const range = await createLabRange({
    userId: params.userId,
    scenarioId: scenario.id,
    consentId: gate.consent?.id ?? null,
  });

  try {
    // 5b. Admission through the ONE governor (never a second authority).
    const slot = await requestSlot("labRanges", { userId: params.userId, ref: range.id });
    if (slot.status !== "granted") {
      throw new LabRunRefusedError(
        slot.status === "queued" ? `lab_range_capacity (position ${slot.position})` : `lab_range_refused (${slot.reason})`,
      );
    }

    // 4. Pre-flight AFTER the range exists so range-bound rows and the audit
    //    trail have a rangeId; any refusal is recorded and rethrown.
    //
    //    Two paths (Slice 2):
    //      • attested (default) — every target must match a FRESH attested
    //        LabTarget row (§5.2); a refusal writes LabAbuseReport and throws.
    //      • recon (scan-first) — NO attested device required. The caller's
    //        declared scope is validated by validateReconScope: `invalid` values
    //        are a plain validation refusal (no abuse report — mirrors the
    //        attest boundary note); a `tooBroad` network is the §5.2
    //        third-party-scanning guard — audited (reason recon_scope_refused)
    //        and refused with TargetRefusedError (403).
    let targets: NormalizedTarget[];
    if (isRecon) {
      const scope = validateReconScope(params.targets);
      if (scope.invalid.length > 0) {
        throw new LabRunRefusedError(
          `recon_scope_invalid (${scope.invalid.map((i) => `${i.value} (${i.reason})`).join(", ")})`,
        );
      }
      if (scope.tooBroad.length > 0) {
        await db.labAbuseReport.create({
          data: {
            userId: params.userId,
            rangeId: range.id,
            reason: "recon_scope_refused",
            severity: "low",
            evidenceJson: {
              requested: params.targets.map((t) => ({ kind: t.kind, value: t.value })),
              tooBroad: scope.tooBroad.map((p) => ({ kind: p.kind, value: p.value, reason: p.reason })),
              sourceIp: params.sourceIp ?? null,
              at: new Date().toISOString(),
            },
          },
        });
        throw new TargetRefusedError(
          `recon scope refused: ${scope.tooBroad.map((p) => `${p.value} (${p.reason})`).join(", ")}`,
          scope.tooBroad.map((p) => ({ kind: p.kind, value: p.value, reason: p.reason })),
        );
      }
      targets = scope.kept;
    } else {
      targets = await preflightRunTargets({
        userId: params.userId,
        rangeId: range.id,
        targets: params.targets,
        sourceIp: params.sourceIp ?? null,
      });
    }

    // 5c. Lifecycle with the hard TTL stamped on activation.
    await provisionRange(range.id);
    await activateRange(range.id, settings.cyberlabFreeMaxRangeMinutes);

    // 6. Dry-run execute (synthetic, declared-targets-guarded). The runner is
    //    chosen by scenario class: recon → generateReconTelemetry (declared
    //    scope); anything else → generateSmokeTelemetry (attested lab hosts).
    //    Both return the same shape and enforce the same hard line (they throw
    //    if synthetic telemetry references a value outside the declared set).
    const startedAt = new Date();
    const endedAt = new Date();
    const run = isRecon
      ? generateReconTelemetry({ rangeId: range.id, scenarioSlug: slug, targets, startedAt, endedAt })
      : generateSmokeTelemetry({
          rangeId: range.id,
          scenarioSlug: slug,
          targets: targets.map((t) => t.value),
          startedAt,
          endedAt,
        });
    // 6b. C2b victim sensor (§13): the user's OWN devices' agent rows for this
    //     run's window become REAL evidence — same manifest, same signature.
    //     A refusal here (device not readable by this user) fails the range and
    //     rethrows; the abuse report is already written by the sensor module.
    //     Collected BEFORE the artefacts so timeline.json and the stored episode
    //     timeline cover the same entries (they must never disagree).
    let victim: LabRunResult["victim"] = null;
    let victimEnvelope: Record<string, unknown> | null = null;
    if (params.victimDeviceIds && params.victimDeviceIds.length > 0) {
      const sensor = await collectVictimSensor({
        userId: params.userId,
        rangeId: range.id,
        deviceIds: params.victimDeviceIds,
        startedAt,
        endedAt,
      });
      run.timeline.push(...sensor.timelineEntries);
      victim = sensor.summary;
      victimEnvelope = sensor.envelope as unknown as Record<string, unknown>;
    }

    const artefacts: EvidenceArtefact[] = [
      ...run.artefacts,
      { path: "timeline.json", content: JSON.stringify({ mode: "dry-run", scenarioSlug: slug, entries: run.timeline }, null, 2) },
    ];
    if (victimEnvelope !== null) {
      // The manifest hashes the artefact bytes; the episode timeline Json stores
      // the same envelope object — both views of one truth.
      artefacts.push({ path: "victim/agent-sensor.json", content: JSON.stringify(victimEnvelope, null, 2) });
    }

    // 7. Signed, append-only episode (monthly cap enforced inside).
    const episode = await createEpisode({
      rangeId: range.id,
      userId: params.userId,
      scenarioSlug: slug,
      mode: "dry-run",
      techniqueIds: run.techniques,
      telemetrySignatures: run.telemetrySignatures,
      timeline: run.timeline,
      artefacts,
      victim: victimEnvelope,
      startedAt,
      endedAt,
      outcome: "completed_dry_run",
    });

    // 8. Verified teardown — the only acceptable exit besides `failed`.
    //    C2a verification basis (honest): the dry-run provisions NOTHING
    //    outside this database, and the runner has no I/O, so teardown is
    //    proven by the state transition completing with the range's own row
    //    as the whole inventory. Live ranges (C2b) verify against real hosts.
    await beginTeardown(range.id);
    await completeTeardown(range.id, true);

    return {
      rangeId: range.id,
      episodeId: episode.id,
      scenarioSlug: slug,
      mode: "dry-run",
      targets,
      techniques: run.techniques,
      telemetrySignatures: run.telemetrySignatures,
      timeline: run.timeline,
      artefacts,
      signedHash: episode.signedHash,
      verified: true,
      victim,
    };
  } catch (err) {
    // A range must never dangle in a live state after a failed attempt.
    await ensureRangeFailed(range.id, err);
    throw err;
  }
}

/** Best-effort: mark a non-terminal range `failed` (never touches terminal states). */
async function ensureRangeFailed(rangeId: string, error: unknown): Promise<void> {
  const range = await db.labRange.findUnique({ where: { id: rangeId } });
  if (!range || range.state === "failed" || range.state === "torn_down") return;
  try {
    await failRange(rangeId, error instanceof Error ? error.message : String(error));
  } catch {
    // A concurrent transition won; the range is not dangling either way.
  }
}

