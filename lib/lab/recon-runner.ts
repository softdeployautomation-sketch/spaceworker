import { EVIDENCE_SCHEMA_VERSION, type EvidenceArtefact } from "./evidence";
import type { TimelineEntry } from "./runner";
import { RECON_SIGNATURE_IDS, RECON_TECHNIQUE_IDS } from "./recon-core";
import type { NormalizedTarget } from "./targets-core";

// TASK_156B Slice 2 (PLAN §3.2) — the simulated scan-first recon telemetry.
// Same shape and SAME hard line as lib/lab/runner.ts generateSmokeTelemetry:
// every artefact is labelled `synthetic: true`, run.json-equivalent says
// `mode: "dry-run"`, and the generator THROWS if any emitted value is outside
// the declared scope. Recon is SIMULATED today — no packet leaves the platform,
// nothing contacts a host — so this proves the recon half of the kill chain
// (declare scope → enumerate surface → trip a detection → signed evidence)
// without any attack infrastructure.
//
// The declared scope comes from validateReconScope (lib/lab/recon-core.ts):
// well-formed, in-breadth targets the caller is authorized to test. This runner
// never invents an address — the surface it "enumerates" is derived from the
// declared targets only.

export interface ReconTelemetryInput {
  rangeId: string;
  scenarioSlug: string;
  /** Already scope-validated recon targets (kind+value normalised). */
  targets: readonly NormalizedTarget[];
  startedAt: Date;
  endedAt: Date;
}

export interface ReconTelemetry {
  artefacts: EvidenceArtefact[];
  timeline: TimelineEntry[];
  techniques: string[];
  telemetrySignatures: string[];
}

/** Milliseconds between two synthetic timeline events (ordering is all that matters). */
function step(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

/** One synthetic artefact: JSON content, self-describing via the synthetic flag. */
function syntheticArtefact(path: string, body: Record<string, unknown>): EvidenceArtefact {
  return { path, content: JSON.stringify(body, null, 2) };
}

/**
 * Generate the synthetic recon telemetry for one dry-run episode.
 *
 * Emits `surface.json` (the enumerated attack surface for each declared target)
 * and `detections.json` (the synthetic alerts the enumeration "trips"), plus the
 * ordered timeline and technique/signature id sets.
 *
 * THROWS (RangeError) if `targets` is empty or if any value the emitted records
 * reference is not in the declared set — the §5.2 hard line made executable: a
 * future edit that leaks a non-declared address into "synthetic" recon data is
 * caught loudly, exactly as in the smoke runner.
 */
export function generateReconTelemetry(input: ReconTelemetryInput): ReconTelemetry {
  if (input.targets.length === 0) throw new RangeError("recon telemetry requires at least one declared target");
  const allowed = new Set(input.targets.map((t) => t.value));
  const assertAllowed = (value: string): void => {
    if (!allowed.has(value)) throw new RangeError(`recon telemetry referenced undeclared scope value: ${value}`);
  };

  // The simulated enumerated surface is DERIVED from the declared targets — the
  // only values that may appear anywhere in surface.json.
  const surface = input.targets.map((t) => {
    assertAllowed(t.value);
    return {
      target: t.value,
      kind: t.kind,
      // Synthetic "findings" a real recon would surface; deterministic, and
      // every one is anchored to this declared target only.
      simulatedFindings: [
        { label: "host responds to enumeration", technique: "T1595.001" },
        { label: "service probe pattern observed", technique: "T1046" },
      ],
    };
  });

  const artefacts: EvidenceArtefact[] = [
    syntheticArtefact("surface.json", {
      synthetic: true,
      schema: EVIDENCE_SCHEMA_VERSION,
      rangeId: input.rangeId,
      scenarioSlug: input.scenarioSlug,
      scopeDeclared: input.targets.map((t) => ({ kind: t.kind, value: t.value })),
      surface,
    }),
    syntheticArtefact("detections.json", {
      synthetic: true,
      schema: EVIDENCE_SCHEMA_VERSION,
      rangeId: input.rangeId,
      signatures: [...RECON_SIGNATURE_IDS],
      techniques: [...RECON_TECHNIQUE_IDS],
    }),
  ];

  const t0 = input.startedAt;
  const timeline: TimelineEntry[] = [
    { at: t0.toISOString(), event: "range.created", detail: { rangeId: input.rangeId, mode: "dry-run" } },
    {
      at: step(t0, 500).toISOString(),
      event: "recon.scope_declared",
      detail: { scope: input.targets.map((t) => `${t.kind}:${t.value}`) },
    },
  ];
  // One enumeration event per declared target, each naming only its own value.
  input.targets.forEach((t, i) => {
    assertAllowed(t.value);
    timeline.push({
      at: step(t0, 1_000 + i * 250).toISOString(),
      event: "recon.host_enumerated",
      detail: { target: t.value, kind: t.kind },
    });
  });
  timeline.push(
    { at: step(t0, 1_000 + input.targets.length * 250).toISOString(), event: "detection.synthetic_trip", detail: { signatures: [...RECON_SIGNATURE_IDS] } },
    { at: input.endedAt.toISOString(), event: "range.destroyed", detail: { rangeId: input.rangeId, verified: true } },
  );

  return { artefacts, timeline, techniques: [...RECON_TECHNIQUE_IDS], telemetrySignatures: [...RECON_SIGNATURE_IDS] };
}
