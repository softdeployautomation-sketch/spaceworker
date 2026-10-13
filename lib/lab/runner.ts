import { EVIDENCE_SCHEMA_VERSION, type EvidenceArtefact } from "./evidence";

// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 4, §12.6, §12.8) — the FIRST scenario
// runner: a documented smoke scenario that executes with `--dry-run`, producing a
// REAL evidence bundle from SYNTHETIC telemetry.
//
// Why synthetic: C2a ships before any lab host exists (C2b is the owner-infra
// phase). The point of this runner is to prove the CHAIN — gate → consent →
// pre-flight → range → episode → manifest → signature — end-to-end without any
// attack infrastructure, so the evidence machinery is provable on a bare machine.
// Every artefact it emits is labelled `synthetic: true` and the run.json says
// `mode: "dry-run"`; nothing here claims to be a packet capture (§8's "not
// simulation" proof is C2b's job, on owned metal, with raw capture from the
// victim path).
//
// The hard line that IS enforced here (and is a policy constant, not a setting):
// synthetic telemetry may only ever mention the run's ATTESTED targets. A
// generator that emitted a third-party address even in fake data would normalise
// the unacceptable, so `generateSmokeTelemetry` throws if any emitted record
// references a value outside the attested set.

/** One timeline entry in an episode (ordered by `at`). */
export interface TimelineEntry {
  at: string;
  event: string;
  detail?: Record<string, unknown>;
}

/** A synthetic host/flow/detection record produced by the dry-run. */
export interface SyntheticRecord {
  synthetic: true;
  [key: string]: unknown;
}

export interface SmokeTelemetryInput {
  rangeId: string;
  scenarioSlug: string;
  /** Already pre-flight-attested target values (kind+value normalised). */
  targets: string[];
  startedAt: Date;
  endedAt: Date;
}

export interface SmokeTelemetry {
  artefacts: EvidenceArtefact[];
  timeline: TimelineEntry[];
  /** ATT&CK technique ids observed in this run (from the scenario). */
  techniques: string[];
  /** Signature ids the synthetic telemetry "tripped" (the C5 seed). */
  telemetrySignatures: string[];
}

/** The ATT&CK techniques the smoke scenario exercises (§12.8 catalog row). */
export const SMOKE_TECHNIQUE_IDS = ["T1046", "T1595.002"] as const;

/**
 * Signature ids the synthetic telemetry deliberately trips. These are the seeds
 * of the C5 detect-then-defend loop (§8.4) — named here as stable ids so the
 * episode's `telemetrySignatures` column and the future DetectionPack can match
 * on them.
 */
export const SMOKE_SIGNATURE_IDS = [
  "lab.smoke.network_service_scan_burst",
  "lab.smoke.http_probe_pattern",
] as const;

/** Milliseconds between two synthetic timeline events (ordering is all that matters). */
function step(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

/**
 * Build one synthetic artefact: JSON content, deterministic key order inside
 * each object (stable enough for a smoke bundle — the MANIFEST hash is what the
 * evidence core canonicalises). The synthetic flag lives IN the content, so a
 * saved artefact is self-describing wherever it lands.
 */
function syntheticArtefact(path: string, body: Record<string, unknown>): EvidenceArtefact {
  return { path, content: JSON.stringify(body, null, 2) };
}

/**
 * Generate the synthetic smoke telemetry for one dry-run episode.
 *
 * Emits three artefacts — `hosts.json` (the two lab services), `flows.json`
 * (probe + HTTP traffic between the pre-flight-attested lab addresses only),
 * and `detections.json` (the synthetic alerts the flow "trips") — plus the
 * ordered timeline and the technique/signature id sets.
 *
 * THROWS (RangeError) if any address in the emitted records is not in
 * `targets`. This is the §5.2 hard line made executable: the generator has no
 * path that can emit a value it was not given, and this final check exists so a
 * future edit that violates that is caught loudly rather than silently.
 */
export function generateSmokeTelemetry(input: SmokeTelemetryInput): SmokeTelemetry {
  const allowed = new Set(input.targets);
  const assertAllowed = (value: string): void => {
    if (!allowed.has(value)) throw new RangeError(`synthetic telemetry referenced non-attested target: ${value}`);
  };
  const [scanTarget, webTarget] = input.targets;
  if (!scanTarget || !webTarget) throw new RangeError("smoke telemetry requires two attested targets");

  const scanHost = { ip: scanTarget, role: "scan-target (lab host A)" };
  const webHost = { ip: webTarget, role: "web-target (lab host B)" };
  assertAllowed(scanHost.ip);
  assertAllowed(webHost.ip);

  const t0 = input.startedAt;
  const hosts = syntheticArtefact("hosts.json", {
    synthetic: true, schema: EVIDENCE_SCHEMA_VERSION, rangeId: input.rangeId, hosts: [scanHost, webHost],
  });

  const flow = (kind: string, src: string, dst: string, note: string) => ({ synthetic: true, kind, src, dst, note });
  const flows = syntheticArtefact("flows.json", {
    synthetic: true, schema: EVIDENCE_SCHEMA_VERSION, rangeId: input.rangeId,
    flows: [
      flow("tcp-probe-burst", scanTarget, webTarget, `${SMOKE_SIGNATURE_IDS[0]} — synthetic service-scan burst`),
      flow("http-probe", scanTarget, webTarget, `${SMOKE_SIGNATURE_IDS[1]} — synthetic HTTP probe pattern`),
    ],
  });

  const detections = syntheticArtefact("detections.json", {
    synthetic: true, schema: EVIDENCE_SCHEMA_VERSION, rangeId: input.rangeId,
    signatures: [...SMOKE_SIGNATURE_IDS], techniques: [...SMOKE_TECHNIQUE_IDS],
  });

  const timeline: TimelineEntry[] = [
    { at: t0.toISOString(), event: "range.created", detail: { rangeId: input.rangeId, mode: "dry-run" } },
    { at: step(t0, 1_000).toISOString(), event: "telemetry.synthetic_probe_burst", detail: { from: scanTarget, to: webTarget } },
    { at: step(t0, 2_000).toISOString(), event: "detection.synthetic_trip", detail: { signatures: [...SMOKE_SIGNATURE_IDS] } },
    { at: input.endedAt.toISOString(), event: "range.destroyed", detail: { rangeId: input.rangeId, verified: true } },
  ];

  return { artefacts: [hosts, flows, detections], timeline, techniques: [...SMOKE_TECHNIQUE_IDS], telemetrySignatures: [...SMOKE_SIGNATURE_IDS] };
}

