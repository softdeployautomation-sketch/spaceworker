import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "./db";

// JSON columns accept InputJsonValue; null must be Prisma.DbNull.
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

// Task 92 — the shared device layer's server helpers. Every device-side
// feature (Vantra plugin 93, WoL 96, Browser Clone 97, Cyber Lab 98) consumes
// THESE primitives — never invents its own identity/audit/panic plumbing
// (plan CROSS-TRACK RULE 5, Michael directive).

// A heartbeat fresher than this means the device is reachable. Older flips
// the derived status to "offline" on read (lazy, like premium reversion).
export const DEVICE_ONLINE_WINDOW_MS = 10 * 60 * 1000;

export function isDeviceOnline(lastSeenAt: Date | null): boolean {
  return !!lastSeenAt && Date.now() - lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS;
}

/**
 * Derive the display status from the stored row: a stored "asleep" sticks
 * until a heartbeat proves otherwise; otherwise online/offline by age.
 */
export function deviceStatus(device: { status: string; lastSeenAt: Date | null }): string {
  if (device.status === "asleep" && !isDeviceOnline(device.lastSeenAt)) return "asleep";
  return isDeviceOnline(device.lastSeenAt) ? "online" : "offline";
}

// ---------------------------------------------------------------------------
// Task 95 — read models for the device console. ONE selector definition, so
// the list page and the per-device console can never disagree about status
// (the old page double-listed machines with two different statuses).
// ---------------------------------------------------------------------------

export const deviceListSelector = {
  id: true,
  name: true,
  deviceKind: true,
  vantraAgentId: true,
  status: true,
  osName: true,
  osVersion: true,
  lastSeenAt: true,
  createdAt: true,
  powerPolicy: { select: { mode: true, until: true } },
} satisfies Prisma.DeviceSelect;

export type DeviceWithPolicy = Prisma.DeviceGetPayload<{
  select: typeof deviceListSelector;
}>;

/**
 * The canonical status view the API layer maps rows through — the single
 * derivation every devices surface shares.
 */
export function toDeviceView(device: DeviceWithPolicy) {
  return {
    ...device,
    effectiveStatus: deviceStatus(device),
  };
}

export interface HeartbeatInput {
  vantraAgentId: string;
  name?: string;
  osName?: string;
  osVersion?: string;
  agentVersion?: string;
  ipAddress?: string;
  hardwareSummary?: unknown;
  telemetry?: unknown;
}

/**
 * Upsert a heartbeat: finds the Device by its Vantra agent id (Task 93 wires
 * provisioning; until then the row is created on first sight, owned by the
 * user named in the ingest call). Writes a DeviceHeartbeat row and refreshes
 * lastSeenAt/status. Refuses when the owner's master telemetry toggle is off
 * (web-only toggle per plan — no tray in SpaceWorker).
 */
export async function recordHeartbeat(userId: string, input: HeartbeatInput): Promise<{ deviceId: string; created: boolean }> {
  const owner = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, deviceTelemetryEnabled: true },
  });
  if (!owner) throw new Error("owner_not_found");
  if (!owner.deviceTelemetryEnabled) throw new Error("telemetry_disabled");

  const existing = await db.device.findUnique({ where: { vantraAgentId: input.vantraAgentId } });
  const now = new Date();
  const device = existing
    ? await db.device.update({
        where: { id: existing.id },
        data: {
          name: input.name ?? existing.name,
          osName: input.osName ?? existing.osName,
          osVersion: input.osVersion ?? existing.osVersion,
          hardwareSummary:
            input.hardwareSummary !== undefined
              ? toJson(input.hardwareSummary)
              : (existing.hardwareSummary ?? Prisma.DbNull),
          lastSeenAt: now,
          status: "online",
        },
      })
    : await db.device.create({
        data: {
          userId,
          name: input.name ?? `Device ${input.vantraAgentId.slice(-6)}`,
          vantraAgentId: input.vantraAgentId,
          osName: input.osName,
          osVersion: input.osVersion,
          hardwareSummary:
            input.hardwareSummary !== undefined ? toJson(input.hardwareSummary) : undefined,
          lastSeenAt: now,
          status: "online",
        },
      });

  await db.deviceHeartbeat.create({
    data: {
      deviceId: device.id,
      agentVersion: input.agentVersion,
      ipAddress: input.ipAddress,
      telemetry: input.telemetry !== undefined ? toJson(input.telemetry) : undefined,
    },
  });
  return { deviceId: device.id, created: !existing };
}

/** Canonical device audit write (shared primitive — audit rows survive deletes). */
export async function recordDeviceAudit(opts: {
  deviceId: string;
  event: string;
  actor?: string;
  channel?: string;
  detail?: unknown;
}): Promise<void> {
  await db.deviceAudit.create({
    data: {
      deviceId: opts.deviceId,
      event: opts.event,
      actor: opts.actor ?? "system",
      channel: opts.channel,
      detail: opts.detail !== undefined ? (opts.detail as object) : undefined,
    },
  });
}

/** Canonical PRODUCT audit write for gated agent/device actions (plan §SCHEMA). */
export async function recordAgentActionAudit(opts: {
  userId?: string;
  pendingActionId?: string;
  action: string;
  status: "created" | "approved" | "rejected" | "executed" | "failed" | "expired";
  initiatingChannel?: string;
  approvalChannel?: string;
  sourceDeviceId?: string;
  destinationDeviceId?: string;
  cloneId?: string;
  detail?: unknown;
}): Promise<void> {
  await db.agentActionAudit.create({
    data: {
      userId: opts.userId,
      pendingActionId: opts.pendingActionId,
      action: opts.action,
      status: opts.status,
      initiatingChannel: opts.initiatingChannel ?? "web",
      approvalChannel: opts.approvalChannel,
      sourceDeviceId: opts.sourceDeviceId,
      destinationDeviceId: opts.destinationDeviceId,
      cloneId: opts.cloneId,
      detail: opts.detail !== undefined ? (opts.detail as object) : undefined,
    },
  });
}

/**
 * THE panic switch (plan CROSS-TRACK RULE 6 — total, singular). For this
 * user, in one sweep: expire every pending agent proposal, cancel every
 * queued/running device job, kill requested/approved device actions, switch
 * power policies off, and revoke pending/active browser clones (TASK_109 —
 * sessions torn down, terminal audit written). Clone sessions and lab ranges
 * (later tasks) extend THIS function — they must not build a separate
 * revocation path.
 */
export async function panicStopAllDevices(userId: string, actor = "user"): Promise<{
  expiredProposals: number;
  cancelledJobs: number;
  cancelledActions: number;
  policiesOff: number;
  clonesRevoked: number;
  cloneSessionsStopped: number;
}> {
  const now = new Date();
  const expiredProposals = await db.agentPendingAction.updateMany({
    where: { userId, status: "pending" },
    data: { status: "expired", expiresAt: now },
  });
  const cancelledJobs = await db.deviceJob.updateMany({
    where: { userId, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", finishedAt: now, error: "panic_stop" },
  });
  const cancelledActions = await db.deviceAction.updateMany({
    where: { userId, status: { in: ["requested", "approved", "executing"] } },
    data: { status: "cancelled", error: "panic_stop" },
  });
  const policiesOff = await db.devicePowerPolicy.updateMany({
    where: { device: { userId }, mode: { not: "off" } },
    data: { mode: "off", until: null },
  });

  // TASK_109 (TASK_97 deliverable 5) — the clone leg rides THIS switch; there
  // is no sibling clone kill path. It revokes every non-terminal clone and
  // tears down every live session through the same TASK_108 transport + audit
  // path as any other device action. Lazy import on purpose: lib/clone.ts
  // imports deviceStatus/recordAgentActionAudit from THIS module, so a static
  // import here would close an import cycle.
  const { revokeClonesForPanic } = await import("./clone");
  const cloneLeg = await revokeClonesForPanic(userId, actor);

  // Per-device audit rows for the panic event itself.
  const devices = await db.device.findMany({ where: { userId }, select: { id: true } });
  if (devices.length > 0) {
    await db.deviceAudit.createMany({
      data: devices.map((d) => ({
        deviceId: d.id,
        event: "panic_stop",
        actor,
        channel: "web",
        detail: {
          expiredProposals: expiredProposals.count,
          cancelledJobs: cancelledJobs.count,
          cancelledActions: cancelledActions.count,
          clonesRevoked: cloneLeg.clonesRevoked,
          cloneSessionsStopped: cloneLeg.cloneSessionsStopped,
        },
      })),
    });
  }
  await recordAgentActionAudit({
    userId,
    action: "panic_stop",
    status: "executed",
    detail: {
      expiredProposals: expiredProposals.count,
      cancelledJobs: cancelledJobs.count,
      cancelledActions: cancelledActions.count,
      policiesOff: policiesOff.count,
      clonesRevoked: cloneLeg.clonesRevoked,
      cloneSessionsStopped: cloneLeg.cloneSessionsStopped,
      cloneErrors: cloneLeg.errors,
    },
  });
  return {
    expiredProposals: expiredProposals.count,
    cancelledJobs: cancelledJobs.count,
    cancelledActions: cancelledActions.count,
    policiesOff: policiesOff.count,
    clonesRevoked: cloneLeg.clonesRevoked,
    cloneSessionsStopped: cloneLeg.cloneSessionsStopped,
  };
}