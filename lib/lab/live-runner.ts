// TASK_156B REAL EGRESS (PLAN_CYBERLAB_REAL_EGRESS.md §2) — the LIVE server-
// egress runner. This is the ONE place in the lab that opens a real socket out
// of the platform: a TCP connect to each declared host on each scanned port,
// recording open/closed/filtered from the actual kernel result.
//
// WHY A REAL CONNECT (not a packet craft): connect() to a closed port returns
// ECONNREFUSED, to an open port completes the handshake, and to a filtered port
// times out — three distinguishable outcomes, all captured by node:net with no
// raw-socket privilege and no scanning library. That is enough to show a real VM
// is (or is not) exposed, which is exactly the ad's claim.
//
// THE HARD LINE IS UNCHANGED (§5.2): every emitted record may only reference a
// DECLARED target, and the runner THROWS if any result escapes that set — same
// guarantee as the smoke and recon runners. The ONLY change from recon is
// honesty: the artefacts say `synthetic: false` / `mode: "live"`, and the bytes
// in `surface.json` came off the wire.
//
// The socket work is behind an injectable `PortProbe` so tests supply a fake and
// NEVER open a real connection; `netProbe` is the real one. `server-only` — no
// client bundle may import it.

import "server-only";

import { connect, type Socket } from "node:net";

import { EVIDENCE_SCHEMA_VERSION, type EvidenceArtefact } from "./evidence";
import { LIVE_SIGNATURE_IDS, LIVE_TECHNIQUE_IDS, normalizeLivePort } from "./live-core";
import type { TimelineEntry } from "./runner";

/** The three distinguishable outcomes of a TCP connect probe. */
export type PortState = "open" | "closed" | "filtered";

/** One host×port probe result — the unit of real evidence. */
export interface LiveProbeResult {
  host: string;
  port: number;
  state: PortState;
  /** Real probe latency (ms); UI treats this as layout, never a measurement. */
  ms: number;
}

/** The injectable probe seam: real `netProbe` in prod, a fake in tests. */
export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<PortState>;

/** A declared target as the live runner needs it (kind+value normalised). */
export interface NormalizedTargetLike {
  kind: string;
  value: string;
}

export interface LiveTelemetryInput {
  rangeId: string;
  scenarioSlug: string;
  targets: readonly NormalizedTargetLike[];
  ports: readonly number[];
  startedAt: Date;
  endedAt: Date;
  probe?: PortProbe;
  timeoutMs?: number;
}

export interface LiveTelemetry {
  artefacts: EvidenceArtefact[];
  timeline: TimelineEntry[];
  techniques: string[];
  telemetrySignatures: string[];
  results: LiveProbeResult[];
}

/** Per-probe connect timeout: long enough to distinguish filtered from closed. */
export const LIVE_PROBE_TIMEOUT_MS = 2_000;

function step(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

/** The base IP to probe for a declared target (a `network` probes its own address). */
function probeHost(value: string): string {
  return value.includes("/") ? value.split("/")[0] : value;
}

/**
 * The REAL probe: one TCP connect to `host:port`. `open` on a completed
 * handshake, `closed` on ECONNREFUSED, `filtered` on timeout or any other error
 * (an unreachable host reads as filtered, never a false "closed"). The socket is
 * always destroyed so nothing dangles.
 */
export const netProbe: PortProbe = (host, port, timeoutMs) =>
  new Promise<PortState>((resolve) => {
    let settled = false;
    const finish = (state: PortState): void => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    const socket: Socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish("open");
      socket.destroy();
    });
    socket.once("timeout", () => {
      finish("filtered");
      socket.destroy();
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ECONNREFUSED" ? "closed" : "filtered");
      socket.destroy();
    });
  });

/**
 * Run the LIVE scan: for each declared host, probe each requested port with the
 * injected probe, then build the evidence bundle. THROWS (RangeError) if
 * `targets`/`ports` are empty or if any result references an undeclared value —
 * the §5.2 hard line, identical to the smoke and recon runners.
 */
export async function generateLiveTelemetry(input: LiveTelemetryInput): Promise<LiveTelemetry> {
  if (input.targets.length === 0) throw new RangeError("live telemetry requires at least one declared target");
  if (input.ports.length === 0) throw new RangeError("live telemetry requires at least one port to probe");
  const probe = input.probe ?? netProbe;
  const timeoutMs = input.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS;

  // The declared hosts; a result naming anything else is a leak and aborts.
  const allowed = new Map<string, NormalizedTargetLike>();
  for (const t of input.targets) allowed.set(probeHost(t.value), t);
  const assertAllowed = (host: string): void => {
    if (!allowed.has(host)) throw new RangeError(`live telemetry referenced undeclared target: ${host}`);
  };

  const results: LiveProbeResult[] = [];
  for (const t of input.targets) {
    const host = probeHost(t.value);
    assertAllowed(host);
    for (const port of input.ports) {
      if (normalizeLivePort(port) === null) throw new RangeError(`live telemetry probed an invalid port: ${port}`);
      const began = Date.now();
      const state = await probe(host, port, timeoutMs);
      results.push({ host, port, state, ms: Date.now() - began });
    }
  }

  const openPorts = results.filter((r) => r.state === "open");

  const artefacts: EvidenceArtefact[] = [
    {
      path: "surface.json",
      content: JSON.stringify(
        {
          synthetic: false,
          live: true,
          schema: EVIDENCE_SCHEMA_VERSION,
          rangeId: input.rangeId,
          scenarioSlug: input.scenarioSlug,
          scopeDeclared: input.targets.map((t) => ({ kind: t.kind, value: t.value })),
          ports: [...input.ports],
          results,
          openPorts,
        },
        null,
        2,
      ),
    },
    {
      path: "detections.json",
      content: JSON.stringify(
        {
          synthetic: false,
          live: true,
          schema: EVIDENCE_SCHEMA_VERSION,
          rangeId: input.rangeId,
          signatures: [...LIVE_SIGNATURE_IDS],
          techniques: [...LIVE_TECHNIQUE_IDS],
          openPortCount: openPorts.length,
        },
        null,
        2,
      ),
    },
  ];

  const t0 = input.startedAt;
  const timeline: TimelineEntry[] = [
    { at: t0.toISOString(), event: "range.created", detail: { rangeId: input.rangeId, mode: "live" } },
    {
      at: step(t0, 400).toISOString(),
      event: "live.scope_declared",
      detail: { scope: input.targets.map((t) => `${t.kind}:${t.value}`), ports: [...input.ports] },
    },
  ];
  results.forEach((r, i) => {
    timeline.push({
      at: step(t0, 800 + i * 120).toISOString(),
      event: r.state === "open" ? "live.port_open" : r.state === "closed" ? "live.port_closed" : "live.port_filtered",
      detail: { host: r.host, port: r.port, state: r.state, ms: r.ms },
    });
  });
  timeline.push(
    {
      at: step(t0, 800 + results.length * 120).toISOString(),
      event: "detection.real_trip",
      detail: { signatures: [...LIVE_SIGNATURE_IDS], openPorts: openPorts.map((r) => `${r.host}:${r.port}`) },
    },
    { at: input.endedAt.toISOString(), event: "range.destroyed", detail: { rangeId: input.rangeId, verified: true } },
  );

  return { artefacts, timeline, techniques: [...LIVE_TECHNIQUE_IDS], telemetrySignatures: [...LIVE_SIGNATURE_IDS], results };
}

