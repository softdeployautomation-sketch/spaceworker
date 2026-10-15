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
// HONEST LIMIT: the smoke and recon scenarios run in "dry-run" mode — the
// evidence artefacts are SYNTHETIC and say so in their own content; nothing
// touches a real host. The LIVE scenario (klass "live", REAL EGRESS) makes REAL
// TCP connects out of the platform, gated by the master dial
// (AdminSetting.cyberlabLiveEgressEnabled). OWNER DECISION: the dial now ships
// ON (default true) because CyberLab is grant-only and off the Premium Plus
// catch-all — the only people who reach this are the owner's hand-verified
// operators. It remains a dial, so the owner can turn it off and a live-class
// scenario is then refused (no packet leaves). Live runs reuse this exact gate →
// preflight → range → episode chain and label their artefacts
// `synthetic: false` / `mode: "live"`.
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
import { generateLiveTelemetry } from "./live-runner";
import { validateLiveScope, LIVE_DEFAULT_PORTS, normalizeLivePort } from "./live-core";
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
  mode: "dry-run" | "live";
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
  /**
   * TASK_156B REAL EGRESS — the ports a `live` scenario probes per host. Only
   * honoured when the scenario class is `live` AND the ship-dark master dial is
   * on; ignored (and defaulted to LIVE_DEFAULT_PORTS) otherwise. Values are
   * normalised to 1..65535 server-side; an out-of-range port is a refusal, never
   * a silent clamp, so the caller's declared scope and the evidence agree.
   */
  ports?: number[];
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

  // TASK_156B REAL EGRESS — the `live` seam. A `live`-class scenario makes REAL
  // TCP connects out of the platform, but ONLY when the ship-dark master dial is
  // on. While it is off (the default), a live-class scenario is refused outright
  // (scenario_not_allowed reaches it via the disabled row) so no packet can be
  // sent by accident. The dial check is re-asserted here so a manually re-enabled
  // row can never bypass the switch.
  const isLive = scenario.klass === "live" && settings.cyberlabLiveEgressEnabled === true;
  if (scenario.klass === "live" && !isLive) {
    throw new LabRunRefusedError(`live_egress_disabled (${slug})`);
  }

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
    //    Three paths (Slice 2 + REAL EGRESS):
    //      • live (scan-first, REAL packets) — NO attested device required. The
    //        caller's declared scope is validated by validateLiveScope with the
    //        owner's OPTIONAL dials (breadth guard + allow-list, both default
    //        open). `not_normalized` is a plain refusal; a guard refusal is a
    //        plain TargetRefusedError (NOT audited — this is the owner's
    //        friction=0 posture, not the third-party-scanning guard). Only
    //        reachable when the ship-dark master dial is on (checked above).
    //      • recon (scan-first, SIMULATED) — NO attested device required. The
    //        caller's declared scope is validated by validateReconScope: `invalid`
    //        values are a plain validation refusal (no abuse report — mirrors the
    //        attest boundary note); a `tooBroad` network is the §5.2
    //        third-party-scanning guard — audited (reason recon_scope_refused)
    //        and refused with TargetRefusedError (403).
    //      • attested (default) — every target must match a FRESH attested
    //        LabTarget row (§5.2); a refusal writes LabAbuseReport and throws.
    let targets: NormalizedTarget[];
    let livePorts: number[] | null = null;
    if (isLive) {
      const allowList = (settings.cyberlabEgressAllowList ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const scope = validateLiveScope(params.targets, {
        scopeGuard: settings.cyberlabEgressScopeGuard === true,
        allowList,
      });
      if (scope.issues.length > 0) {
        throw new TargetRefusedError(
          `live scope refused: ${scope.issues.map((p) => `${p.value} (${p.reason})`).join(", ")}`,
          scope.issues.map((p) => ({ kind: p.kind, value: p.value, reason: p.reason })),
        );
      }
      // Ports: honour the caller's list, else the default service set. An
      // out-of-range port is a plain refusal (never a silent clamp) so the
      // declared scope and the signed evidence always agree.
      const requested = params.ports && params.ports.length > 0 ? params.ports : [...LIVE_DEFAULT_PORTS];
      const badPort = requested.find((p) => normalizeLivePort(p) === null);
      if (badPort !== undefined) throw new LabRunRefusedError(`live_port_invalid (${badPort})`);
      livePorts = requested.map((p) => normalizeLivePort(p) as number);
      targets = scope.kept;
    } else if (isRecon) {
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
    //    scope); live → generateLiveTelemetry (REAL TCP connects); anything
    //    else → generateSmokeTelemetry (attested lab hosts). All return the
    //    same shape and enforce the same hard line (they throw if telemetry
    //    references a value outside the declared set). `mode` is threaded
    //    through so the evidence, the episode row and the result all agree.
    const startedAt = new Date();
    const endedAt = new Date();
    const mode: "dry-run" | "live" = isLive ? "live" : "dry-run";
    const run = isLive
      ? await generateLiveTelemetry({
          rangeId: range.id,
          scenarioSlug: slug,
          targets,
          ports: livePorts ?? [],
          startedAt,
          endedAt,
        })
      : isRecon
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
      { path: "timeline.json", content: JSON.stringify({ mode, scenarioSlug: slug, entries: run.timeline }, null, 2) },
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
      mode,
      techniqueIds: run.techniques,
      telemetrySignatures: run.telemetrySignatures,
      timeline: run.timeline,
      artefacts,
      victim: victimEnvelope,
      startedAt,
      endedAt,
      outcome: isLive ? "completed_live" : "completed_dry_run",
    });

    // 8. Verified teardown — the only acceptable exit besides `failed`.
    //    C2a verification basis (honest): the dry-run provisions NOTHING
    //    outside this database, and the runner has no I/O, so teardown is
    //    proven by the state transition completing with the range's own row
    //    as the whole inventory. A LIVE run's verification is the completed
    //    teardown PLUS the recorded probe results in surface.json — real
    //    packets were sent and every open port is captured in the signed
    //    evidence (REAL EGRESS §2).
    await beginTeardown(range.id);
    await completeTeardown(range.id, true);

    return {
      rangeId: range.id,
      episodeId: episode.id,
      scenarioSlug: slug,
      mode,
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

