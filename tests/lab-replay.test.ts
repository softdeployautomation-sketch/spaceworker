import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  REPLAY_WATERMARK_LIVE,
  REPLAY_WATERMARK_SIM,
  buildReplayFrames,
  parseEpisodeTimeline,
  replayWatermark,
} from "@/lib/lab/replay";
import type { TimelineEntry } from "@/lib/lab/runner";

// TASK_156B S7-A — the replay core's contract: tolerate anything stored,
// never invent a frame or a node, and label live runs honestly.

const ENTRIES: TimelineEntry[] = [
  { at: "2026-10-16T10:00:00.000Z", event: "range.created" },
  { at: "2026-10-16T10:00:01.000Z", event: "telemetry.service_open", detail: { from: "10.0.0.5", to: "10.0.0.9" } },
  { at: "2026-10-16T10:00:02.000Z", event: "detection.smoke_trip", detail: { to: "10.0.0.9" } },
  { at: "2026-10-16T10:00:03.000Z", event: "range.destroyed" },
];

describe("parseEpisodeTimeline", () => {
  test("parses the stored shape (mode, scenarioSlug, entries, detail)", () => {
    const p = parseEpisodeTimeline({ mode: "live", scenarioSlug: "live-server-egress", entries: ENTRIES });
    assert.equal(p.mode, "live");
    assert.equal(p.scenarioSlug, "live-server-egress");
    assert.equal(p.entries.length, ENTRIES.length);
    assert.deepEqual(p.entries[1].detail, { from: "10.0.0.5", to: "10.0.0.9" });
  });

  test("never throws on hostile/foreign shapes and filters malformed rows", () => {
    for (const bad of [null, undefined, "x", 42, {}, { entries: "nope" }, { mode: 3, entries: {} }]) {
      const p = parseEpisodeTimeline(bad);
      assert.equal(p.entries.length, 0);
      assert.equal(p.mode, "unknown");
    }
    const p = parseEpisodeTimeline({
      mode: "dry-run",
      entries: [null, 7, { at: "x" }, { event: "y" }, { at: "2026-01-01T00:00:00.000Z", event: "ok", detail: { a: 1 } }],
    });
    assert.equal(p.entries.length, 1);
    assert.equal(p.entries[0].event, "ok");
    assert.deepEqual(p.entries[0].detail, { a: 1 });
  });

  test("absent mode degrades to unknown (never assumes live)", () => {
    assert.equal(parseEpisodeTimeline({ entries: [] }).mode, "unknown");
  });
});

describe("replayWatermark", () => {
  test("live runs say AUTHORIZED LIVE TEST, everything else says SIMULATION", () => {
    assert.equal(replayWatermark("live"), REPLAY_WATERMARK_LIVE);
    assert.equal(replayWatermark("dry-run"), REPLAY_WATERMARK_SIM);
    assert.equal(replayWatermark("unknown"), REPLAY_WATERMARK_SIM);
    assert.notEqual(REPLAY_WATERMARK_LIVE, REPLAY_WATERMARK_SIM);
  });
});

describe("buildReplayFrames", () => {
  test("one frame per real entry, deterministic across builds", () => {
    const a = buildReplayFrames(ENTRIES);
    const b = buildReplayFrames(ENTRIES);
    assert.equal(a.length, ENTRIES.length);
    assert.deepEqual(a, b);
    a.forEach((f, i) => assert.equal(f.index, i));
    a.forEach((f, i) => assert.equal(f.entry.event, ENTRIES[i].event));
  });

  test("cumulative reveal: frame 0 has no arc, frame 1 shows the real one", () => {
    const frames = buildReplayFrames(ENTRIES);
    assert.equal(frames[0].radar.arcs.length, 0); // range.created carries no from/to
    assert.equal(frames[1].radar.arcs.length, 1);
    assert.deepEqual(frames[1].radar.arcs[0], {
      from: "n0",
      to: "n1",
      event: "telemetry.service_open",
      at: ENTRIES[1].at,
    });
    assert.equal(frames[1].radar.pulses.length, 0);
    assert.equal(frames[2].radar.pulses.length, 1); // detection lands frame 2
  });

  test("node topology is FIXED across frames — playback reveals, never invents hosts", () => {
    const frames = buildReplayFrames(ENTRIES);
    const shape = JSON.stringify(frames[0].radar.nodes);
    for (const f of frames) assert.equal(JSON.stringify(f.radar.nodes), shape);
    assert.deepEqual(frames[0].radar.nodes.map((n) => n.value).sort(), ["10.0.0.5", "10.0.0.9"]);
  });

  test("hard line: a detail field mentioning an address does NOT create a node", () => {
    const frames = buildReplayFrames([
      { at: "2026-10-16T10:00:00.000Z", event: "note", detail: { note: "9.9.9.9 was mentioned in prose" } },
      { at: "2026-10-16T10:00:01.000Z", event: "telemetry.service_open", detail: { to: "10.0.0.9" } },
    ]);
    const values = frames[1].radar.nodes.map((n) => n.value);
    assert.ok(!values.includes("9.9.9.9"));
    assert.deepEqual(values, ["10.0.0.9"]);
  });

  test("empty timeline yields zero frames", () => {
    assert.deepEqual(buildReplayFrames([]), []);
  });
});
