// TASK_156B S7-A (PLAN_CYBERLAB_NEXT_S7_REPLAY_AND_TOOL_BRIDGE.md §A) — the pure
// replay core: turn a STORED signed episode (LabEpisode.timeline Json) into the
// frames a scrubber player steps through. DELIBERATELY free of server-only/db/
// network imports (same house reason as console-map.ts): the server could stream
// it, the client renders it, one mapping never two copies.
//
// The hard line (PLAN §5, inherited): a frame can only draw what the episode's
// OWN timeline really recorded. Node topology comes from targetsFromTimeline
// (addresses the episode's events actually named) and is FIXED across all
// frames — playback reveals arcs/pulses over time (RadialNet reveal semantics),
// it never invents hosts mid-replay. Every frame is buildRadarModel over a
// prefix of the real entries — deterministic, same episode → same frames.

import {
  buildRadarModel,
  targetsFromTimeline,
  type RadarModel,
  type RadarTargetInput,
} from "./console-map";
import type { TimelineEntry } from "./runner";

// ---------------------------------------------------------------------------

export const REPLAY_WATERMARK_LIVE = "AUTHORIZED LIVE TEST · REAL PACKETS";
export const REPLAY_WATERMARK_SIM = "SIMULATION · YOUR EQUIPMENT";

export type ParsedMode = "dry-run" | "live" | "unknown";

export interface ParsedEpisodeTimeline {
  mode: ParsedMode;
  scenarioSlug: string | null;
  entries: TimelineEntry[];
}

/**
 * Tolerantly parse the stored timeline Json. NEVER throws: foreign, legacy or
 * tampered shapes degrade to `entries: []` (the player shows "no frames"
 * instead of crashing) — the signature banner, not this parser, is what tells
 * the viewer whether the evidence is intact.
 */
export function parseEpisodeTimeline(json: unknown): ParsedEpisodeTimeline {
  const rec = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const raw = Array.isArray(rec.entries) ? rec.entries : [];
  const entries: TimelineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.at !== "string" || typeof e.event !== "string") continue;
    entries.push({
      at: e.at,
      event: e.event,
      ...(e.detail && typeof e.detail === "object" ? { detail: e.detail as Record<string, unknown> } : {}),
    });
  }
  const mode: ParsedMode = rec.mode === "live" ? "live" : rec.mode === "dry-run" ? "dry-run" : "unknown";
  return { mode, scenarioSlug: typeof rec.scenarioSlug === "string" ? rec.scenarioSlug : null, entries };
}

/** Mode-aware replay watermark — a live run is never mislabelled as a sim. */
export function replayWatermark(mode: ParsedMode): string {
  return mode === "live" ? REPLAY_WATERMARK_LIVE : REPLAY_WATERMARK_SIM;
}

// ---------------------------------------------------------------------------

export interface ReplayFrame {
  /** 0-based position in the episode's timeline. */
  index: number;
  /** The REAL event this frame lands on. */
  entry: TimelineEntry;
  /** Cumulative radar model over entries[0..index] — the console-map mapping. */
  radar: RadarModel;
}

/**
 * Build every frame of a replay. Topology (nodes) is computed ONCE from the
 * full entry list and reused per frame, so the drawn host set is exactly the
 * set a real event in this episode named — identical on every frame. O(n²) in
 * entries by design (prefix recompute per frame): episode timelines are small
 * and bounded, and reusing buildRadarModel verbatim is worth more than the
 * micro-optimisation.
 */
export function buildReplayFrames(entries: readonly TimelineEntry[]): ReplayFrame[] {
  const targets: RadarTargetInput[] = targetsFromTimeline(entries);
  return entries.map((entry, index) => ({
    index,
    entry,
    radar: buildRadarModel(targets, entries.slice(0, index + 1)),
  }));
}
