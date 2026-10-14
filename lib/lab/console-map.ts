// TASK_156B UI-1 (PLAN_CYBERLAB_STANDALONE_UI.md §2/§3 S2/S3) — the pure event →
// visual mapping the Operation Console renders from. DELIBERATELY free of
// "server-only", db and network imports so the SAME module is imported by the
// server (SSE route) and the client (radar/rail/feed components) — one mapping,
// never two copies that can drift.
//
// The hard line this file encodes (PLAN §5): NOTHING is drawable that a real
// event did not put there.
//   - Radar nodes come ONLY from the run's attested targets (which pre-flight
//     already proved are the user's). A timeline detail mentioning an unknown
//     address can never create a node — buildRadarModel ignores it.
//   - Arcs come ONLY from timeline entries that carry a real {from, to} pair,
//     and both endpoints must be attested nodes or the arc is dropped.
//   - Pulses come ONLY from real `detection.*` events, and only at attested
//     nodes.
//   - Ring distance is LAYOUT (target order), never a measurement: the dry-run
//     has no latency data, and inventing one would be the exact "fake number"
//     the plan forbids. The UI caption says rings are layout, not latency.
//
// Stage mapping is the Falcon-style rail (PLAN §3 S2 left pane): every real
// timeline event name lands on exactly one kill-chain stage; unknown events
// land on `recon` (visible, not hidden) so a new engine event name shows up in
// the console instead of silently disappearing.

import type { TimelineEntry } from "./runner";

// ---------------------------------------------------------------------------
// The stage rail
// ---------------------------------------------------------------------------

export const LAB_STAGE_IDS = [
  "arming",
  "recon",
  "discovery",
  "initial-access",
  "execution",
  "detected",
  "teardown",
  "signed",
] as const;
export type LabStageId = (typeof LAB_STAGE_IDS)[number];

export interface LabStage {
  id: LabStageId;
  label: string;
  /** Plain-language line for the rail tooltip/caption. */
  caption: string;
}

export const LAB_STAGES: readonly LabStage[] = [
  { id: "arming", label: "Arming", caption: "Gate, caps and pre-flight; range created." },
  { id: "recon", label: "Recon", caption: "Targeting and enumeration activity." },
  { id: "discovery", label: "Discovery", caption: "Service/asset discovery against attested targets." },
  { id: "initial-access", label: "Initial access", caption: "Delivery/lure stage (phish-class scenarios)." },
  { id: "execution", label: "Execution", caption: "Payload/agent activity — incl. victim-sensor rows." },
  { id: "detected", label: "Detected / defended", caption: "Detections tripped by the run's telemetry." },
  { id: "teardown", label: "Teardown", caption: "Range teardown (verified) — cleanup checklist." },
  { id: "signed", label: "Signed", caption: "Evidence manifest signed; episode append-only." },
] as const;

/**
 * Map one REAL timeline event name to its stage. Prefix rules follow the
 * engine's actual event vocabulary (lib/lab/runner.ts + victim-sensor.ts):
 *
 *   range.created            → arming
 *   telemetry.*              → discovery   (the smoke probe burst, T1046)
 *   detection.*              → detected    (synthetic trip / future real trips)
 *   victim.*                 → execution   (victim-side sensor evidence)
 *   range.destroyed          → teardown
 *
 * Unknown names land on `recon` — visible in the rail rather than dropped.
 */
export function mapEventToStage(event: string): LabStageId {
  if (event === "range.created") return "arming";
  if (event === "range.destroyed") return "teardown";
  if (event.startsWith("telemetry.")) return "discovery";
  if (event.startsWith("detection.")) return "detected";
  if (event.startsWith("victim.")) return "execution";
  return "recon";
}

/** The set of stages hit by a timeline, in rail order (for "completed" styling). */
export function stagesHit(entries: readonly TimelineEntry[]): Set<LabStageId> {
  const hit = new Set<LabStageId>();
  for (const e of entries) hit.add(mapEventToStage(e.event));
  return hit;
}

/** The latest stage reached so far (the rail's active glow). */
export function activeStage(entries: readonly TimelineEntry[]): LabStageId | null {
  let best = -1;
  for (const e of entries) {
    const idx = LAB_STAGE_IDS.indexOf(mapEventToStage(e.event));
    if (idx > best) best = idx;
  }
  return best >= 0 ? LAB_STAGE_IDS[best] : null;
}

// ---------------------------------------------------------------------------
// The radar model
// ---------------------------------------------------------------------------

export interface RadarTargetInput {
  kind: string;
  value: string;
}

export interface RadarNode {
  /** Stable per-run node id (index-ordered). */
  id: string;
  value: string;
  kind: string;
  /** 1-based concentric ring index — LAYOUT by target order, not distance. */
  ring: number;
  /** Evenly-spread angle in degrees (0–360) — layout, not bearing. */
  angleDeg: number;
}

export interface RadarArc {
  from: string;
  to: string;
  /** The timeline event that drew this arc (real event name). */
  event: string;
  at: string;
}

export interface RadarPulse {
  node: string;
  event: string;
  at: string;
}

export interface RadarModel {
  nodes: RadarNode[];
  arcs: RadarArc[];
  pulses: RadarPulse[];
  /** Highest rail stage reached (null = no events yet). */
  activeStage: LabStageId | null;
  /**
   * Events that referenced addresses NOT in the attested set — recorded so the
   * feed can show they were IGNORED for drawing, proving the hard line held.
   */
  ignoredAddressRefs: Array<{ at: string; event: string; value: string }>;
}

/** Rings drawn when nothing is attested yet (pure grid, no data). */
export const RADAR_GRID_RINGS = 4;

/**
 * Build the radar model from the run's ATTESTED targets + its REAL timeline.
 * Pure and deterministic: same inputs → same geometry, every time.
 */
export function buildRadarModel(targets: readonly RadarTargetInput[], entries: readonly TimelineEntry[]): RadarModel {
  const nodes: RadarNode[] = targets.map((t, i) => ({
    id: `n${i}`,
    value: t.value,
    kind: t.kind,
    // ≤3 targets sit on the inner operational ring; beyond that, spread across
    // rings 1–3 by order. This is LAYOUT, not a measurement (see header).
    ring: targets.length <= 3 ? 1 : (i % 3) + 1,
    angleDeg: targets.length === 1 ? 0 : (360 / targets.length) * i,
  }));
  const byValue = new Map(nodes.map((n) => [n.value, n.id]));

  const arcs: RadarArc[] = [];
  const pulses: RadarPulse[] = [];
  const ignoredAddressRefs: RadarModel["ignoredAddressRefs"] = [];

  for (const e of entries) {
    const detail = (e.detail ?? {}) as Record<string, unknown>;
    const from = typeof detail.from === "string" ? detail.from : null;
    const to = typeof detail.to === "string" ? detail.to : null;
    if (from !== null || to !== null) {
      const fromId = from !== null ? byValue.get(from) : undefined;
      const toId = to !== null ? byValue.get(to) : undefined;
      for (const v of [from, to]) {
        if (v !== null && !byValue.has(v)) ignoredAddressRefs.push({ at: e.at, event: e.event, value: v });
      }
      // Both endpoints must be attested nodes — a half-known pair draws nothing.
      if (fromId && toId && fromId !== toId) arcs.push({ from: fromId, to: toId, event: e.event, at: e.at });
    }
    if (mapEventToStage(e.event) === "detected") {
      // A detection pulses at the run's target(s). The smoke trip names no
      // single host, so it pulses every node — still only attested ones.
      const target = typeof detail.to === "string" ? byValue.get(detail.to) : undefined;
      if (target) pulses.push({ node: target, event: e.event, at: e.at });
      else for (const n of nodes) pulses.push({ node: n.id, event: e.event, at: e.at });
    }
  }

  return { nodes, arcs, pulses, activeStage: activeStage(entries), ignoredAddressRefs };
}

/**
 * The attested set a recorded run actually used, derived from its OWN timeline:
 * the unique {from,to} addresses real events referenced, order-stable. Used by
 * the SSE stream to seed the radar — nodes can only ever be addresses a real
 * event in this episode named (nothing else is known at replay time, and
 * inventing inventory would break the §5/PLAN hard line).
 */
export function targetsFromTimeline(entries: readonly TimelineEntry[]): RadarTargetInput[] {
  const seen = new Set<string>();
  const out: RadarTargetInput[] = [];
  for (const e of entries) {
    const detail = (e.detail ?? {}) as Record<string, unknown>;
    for (const key of ["from", "to"] as const) {
      const v = detail[key];
      if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
        seen.add(v);
        out.push({ kind: "host", value: v });
      }
    }
  }
  return out;
}


