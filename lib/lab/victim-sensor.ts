// TASK_156B C2b (PLAN_TASK_156 §13, build order item 1) — agent-as-victim-sensor.
//
// The BYOT ruling says the platform owns "the attack and the records", and we
// must "see what happens on the OTHER end". The other end is the user's own
// device running our agent (VantraLink), and the sensor is already there:
// DeviceHeartbeat / DeviceAudit / DeviceJob / DeviceAction rows are written by
// the device itself. This module reads those rows for the run's window and turns
// them into REAL evidence artefacts that join the signed episode manifest —
// victim-side observations that are not the attacker script's claim about them.
//
// Hard lines (mirrors preflightRunTargets' §5.2 discipline):
//   - The device query is ALWAYS scoped by `userId` — a victim device id from
//     another account is not "missing", it is a refusal: the refusal writes a
//     LabAbuseReport (reason `victim_device_refused`) and throws before any row
//     is read. Body-supplied ids are never trusted as an ownership oracle.
//   - The window is [startedAt − lookback, endedAt] — rows outside it are never
//     fetched, so the sensor cannot retro-dress an episode with unrelated
//     history. The exact bounds are INSIDE the artefact, so the claim is auditable.
//   - An empty result is honest: `counts` are real totals for the window and
//     `streams` may legitimately be empty (agent offline). Absence of evidence
//     is recorded as absence, never invented as presence.
//   - Streams are capped (VICTIM_STREAM_CAP rows each) with a `truncated` count:
//     the manifest gets a bounded artefact, the counts still tell the truth.
//
// HONEST LIMIT: this proves what the victim's own agent recorded around the
// run. It does NOT (yet) prove packet-level effects — that is tshark/PCAP,
// owner-host phase, per §13.2. The envelope's schema id versions the shape so a
// later PCAP stream can be added without invalidating older episodes.

import "server-only";

import { db } from "@/lib/db";

import type { TimelineEntry } from "./runner";

/** Bump when the envelope shape changes (additive to stored timeline Json). */
export const VICTIM_SENSOR_SCHEMA = "cyberlab-victim-sensor/v1";

/** Rows fetched per stream (counts remain the true window totals). */
export const VICTIM_STREAM_CAP = 100;

/** How far before `startedAt` the sensor window reaches back for liveness. */
export const VICTIM_SENSOR_LOOKBACK_MS = 15 * 60 * 1000;

/** Thrown when a requested victim device is not readable by THIS user. */
export class VictimDeviceRefusedError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = "VictimDeviceRefusedError";
    this.missing = missing;
  }
}

export interface VictimSensorInput {
  userId: string;
  rangeId: string | null;
  deviceIds: string[];
  startedAt: Date;
  endedAt: Date;
  /** Override the lookback (tests); production uses VICTIM_SENSOR_LOOKBACK_MS. */
  lookbackMs?: number;
}

/** The stored victim section of the episode timeline Json (the defence view). */
export interface VictimEnvelope {
  schema: string;
  rangeId: string | null;
  window: { from: string; to: string };
  devices: Array<{
    id: string;
    name: string;
    deviceKind: string;
    agentBound: boolean;
    osName: string | null;
    status: string;
    lastSeenAt: string | null;
  }>;
  counts: { heartbeats: number; audit: number; jobs: number; actions: number };
  truncated: { heartbeats: number; audit: number; jobs: number; actions: number };
  streams: {
    heartbeats: Array<Record<string, unknown>>;
    audit: Array<Record<string, unknown>>;
    jobs: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
  };
}

export interface VictimSensorResult {
  envelope: VictimEnvelope;
  /** Compact summary for LabRunResult / the run response. */
  summary: {
    deviceCount: number;
    window: { from: string; to: string };
    counts: VictimEnvelope["counts"];
  };
  /** Sensor observations appended to the episode timeline (stored). */
  timelineEntries: TimelineEntry[];
}

/**
 * Collect victim-side agent evidence for one run's window.
 *
 * Order: resolve-and-authorise FIRST (refusal writes the §5.2 report before any
 * row is read), then window-scoped reads with honest counts + capped streams.
 */
export async function collectVictimSensor(params: VictimSensorInput): Promise<VictimSensorResult> {
  if (params.deviceIds.length === 0) {
    throw new VictimDeviceRefusedError("victim_device_refused (no devices requested)", []);
  }

  // 1. Ownership is decided by the QUERY, not by the caller's claim.
  const readable = await db.device.findMany({
    where: { id: { in: params.deviceIds }, userId: params.userId },
    select: { id: true, name: true, deviceKind: true, vantraAgentId: true, osName: true, status: true, lastSeenAt: true },
  });
  const readableIds = new Set(readable.map((d) => d.id));
  const missing = params.deviceIds.filter((id) => !readableIds.has(id));
  if (missing.length > 0) {
    await db.labAbuseReport.create({
      data: {
        userId: params.userId,
        rangeId: params.rangeId,
        reason: "victim_device_refused",
        severity: "medium",
        evidenceJson: {
          requested: params.deviceIds,
          readable: [...readableIds],
          missing,
          sourceIp: null,
          at: new Date().toISOString(),
        },
      },
    });
    throw new VictimDeviceRefusedError(
      `victim device refused: not readable by this user (${missing.join(", ")})`,
      missing,
    );
  }

  // 2. The window: [startedAt − lookback, endedAt]. Bounds live in the artefact.
  const from = new Date(params.startedAt.getTime() - (params.lookbackMs ?? VICTIM_SENSOR_LOOKBACK_MS));
  const to = params.endedAt;
  const ids = [...readableIds];
  const win = { gte: from, lte: to };
  const cap = VICTIM_STREAM_CAP;

  const [hbTotal, auditTotal, jobTotal, actionTotal, hbRows, auditRows, jobRows, actionRows] = await Promise.all([
    db.deviceHeartbeat.count({ where: { deviceId: { in: ids }, createdAt: win } }),
    db.deviceAudit.count({ where: { deviceId: { in: ids }, createdAt: win } }),
    db.deviceJob.count({ where: { deviceId: { in: ids }, createdAt: win } }),
    db.deviceAction.count({ where: { deviceId: { in: ids }, createdAt: win } }),
    db.deviceHeartbeat.findMany({ where: { deviceId: { in: ids }, createdAt: win }, orderBy: { createdAt: "asc" }, take: cap }),
    db.deviceAudit.findMany({ where: { deviceId: { in: ids }, createdAt: win }, orderBy: { createdAt: "asc" }, take: cap }),
    db.deviceJob.findMany({ where: { deviceId: { in: ids }, createdAt: win }, orderBy: { createdAt: "asc" }, take: cap }),
    db.deviceAction.findMany({ where: { deviceId: { in: ids }, createdAt: win }, orderBy: { createdAt: "asc" }, take: cap }),
  ]);

  const counts = { heartbeats: hbTotal, audit: auditTotal, jobs: jobTotal, actions: actionTotal };
  const envelope: VictimEnvelope = {
    schema: VICTIM_SENSOR_SCHEMA,
    rangeId: params.rangeId,
    window: { from: from.toISOString(), to: to.toISOString() },
    devices: readable.map((d) => ({
      id: d.id,
      name: d.name,
      deviceKind: d.deviceKind,
      agentBound: Boolean(d.vantraAgentId),
      osName: d.osName,
      status: d.status,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    })),
    counts,
    truncated: {
      heartbeats: Math.max(0, counts.heartbeats - hbRows.length),
      audit: Math.max(0, counts.audit - auditRows.length),
      jobs: Math.max(0, counts.jobs - jobRows.length),
      actions: Math.max(0, counts.actions - actionRows.length),
    },
    streams: {
      heartbeats: hbRows.map((r) => ({ id: r.id, deviceId: r.deviceId, agentVersion: r.agentVersion, ipAddress: r.ipAddress, createdAt: r.createdAt.toISOString() })),
      audit: auditRows.map((r) => ({ id: r.id, deviceId: r.deviceId, actor: r.actor, channel: r.channel, event: r.event, detail: r.detail, createdAt: r.createdAt.toISOString() })),
      jobs: jobRows.map((r) => ({ id: r.id, deviceId: r.deviceId, jobType: r.jobType, status: r.status, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null })),
      actions: actionRows.map((r) => ({ id: r.id, deviceId: r.deviceId, actionType: r.actionType, status: r.status, createdAt: r.createdAt.toISOString(), executedAt: r.executedAt ? r.executedAt.toISOString() : null })),
    },
  };

  const at = params.endedAt.toISOString();
  const timelineEntries: TimelineEntry[] = readable.map((d) => ({
    at,
    event: "victim.sensor",
    detail: {
      deviceId: d.id,
      deviceName: d.name,
      window: envelope.window,
      counts,
      agentBound: Boolean(d.vantraAgentId),
    },
  }));

  return {
    envelope,
    summary: { deviceCount: readable.length, window: envelope.window, counts },
    timelineEntries,
  };
}

