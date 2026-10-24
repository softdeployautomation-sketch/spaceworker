import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "./db";
import { notifyUser } from "./notify";

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
// 5 min: TRMM agents heartbeat every 30 s, so this allows ~10 missed beats
// before we declare offline — fast enough to feel live without false-flips.
export const DEVICE_ONLINE_WINDOW_MS = 5 * 60 * 1000;

// TASK_238 — how long Vantra's "online" verdict stays trustworthy after the
// last sync saw it. Deliberately much shorter than the heartbeat window: this
// is "we were told online moments ago", not a heartbeat. Three 20s sync polls.
// Without it, an online device whose `lastSeen` is omitted/stale reads offline
// forever (the false-offline bug); with a 5-minute `now` stamp instead, a
// stopped sync kept a dead device green — which is what 29a4483 fixed.
export const VERDICT_FRESH_MS = 60_000;

export function isDeviceOnline(lastSeenAt: Date | null): boolean {
  return !!lastSeenAt && Date.now() - lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS;
}

export function isVerdictFresh(onlineConfirmedAt: Date | null | undefined): boolean {
  return !!onlineConfirmedAt && Date.now() - onlineConfirmedAt.getTime() < VERDICT_FRESH_MS;
}

/**
 * Derive the display status from the stored row.
 *
 * 2026-09-28 (owner report: "it takes long for the active to turn off") — the
 * stored `status` is an AUTHORITATIVE VERDICT, not a hint: `syncDevices()`
 * writes Vantra's live `online` flag every time the device list loads, and
 * `recordHeartbeat()` writes "online" on every agent check-in. This function
 * used to discard that verdict and answer purely from `lastSeenAt` age, so a
 * machine that had just been switched off kept rendering "online · active now"
 * for up to DEVICE_ONLINE_WINDOW_MS (5 minutes) after Vantra had already
 * reported it gone — while Ping, the on-demand truth, correctly said "Agent not
 * reachable" the whole time. Two sources of truth disagreeing in one screen.
 *
 * So: a definite "offline" is honoured immediately; "online"/"asleep"/unknown
 * still have to prove freshness via the age window, which is what makes a
 * device that vanished WITHOUT a verdict age out on its own. "asleep" keeps
 * its old meaning — a deliberate sleep state that survives going stale, but
 * yields to a live heartbeat.
 *
 * TASK_238 — freshness can be proven by EITHER anchor: a real heartbeat
 * (`lastSeenAt`) or a recent online verdict (`onlineConfirmedAt`). Vantra
 * omits `lastSeen` for some online agents; without the verdict anchor those
 * machines were reported offline while online (the false-offline bug). The
 * verdict window is short (VERDICT_FRESH_MS) so a stopped sync still ages out.
 */
export function deviceStatus(device: {
  status: string;
  lastSeenAt: Date | null;
  onlineConfirmedAt?: Date | null;
}): string {
  if (device.status === "asleep") return isDeviceOnline(device.lastSeenAt) ? "online" : "asleep";
  if (device.status === "offline") return "offline";
  return isDeviceOnline(device.lastSeenAt) || isVerdictFresh(device.onlineConfirmedAt)
    ? "online"
    : "offline";
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
  onlineConfirmedAt: true,
  createdAt: true,
  powerPolicy: { select: { mode: true, until: true } },
  // TASK_128 — the row badge (Public/Private) + the onboarding strip render
  // from this selector, so the list needs no second call. `destinationOrgId`
  // and `hideLabel` are here because the strip (§5E wording) and the console's
  // Agent-visibility prefill (§4.3) both read them.
  tier: true,
  onboarding: {
    select: {
      status: true,
      timerStartedAt: true,
      hideDoneAt: true,
      stayOnDoneAt: true,
      releasedAt: true,
      hideLabel: true,
      destinationOrgId: true,
      lastError: true,
    },
  },
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
    select: { id: true, deviceTelemetryEnabled: true, notifyDeviceAdded: true },
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
  // TASK_227 — first sight of this Vantra agent id = a NEW device registered to
  // the account. Mirrors the device-status sweep's notifyUser call shape
  // (try/catch, best-effort): the device + heartbeat rows are already written,
  // so a channel hiccup must never fail the heartbeat itself. Master switch
  // already threw above — this is the finer-grained per-user pref only.
  if (!existing && owner.notifyDeviceAdded) {
    try {
      const os = [device.osName, device.osVersion].filter(Boolean).join(" ");
      await notifyUser(userId, {
        eventType: "device_added",
        subject: `New device added: ${device.name}`,
        emailHtml: `<p><strong>${device.name}</strong> is now registered to your account${os ? ` (${os})` : ""}.</p>`,
        telegramText: `🆕 New device added: ${device.name}.`,
        agentText: `🆕 New device added: ${device.name}.`,
      });
    } catch (err) {
      console.error(`[devices] device_added notify failed for device ${device.id}:`, err);
    }
  }
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
  /** TASK_105 — waiting governor requests withdrawn by this panic. */
  cancelledSlots: number;
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

  // TASK_105 — withdraw this user's WAITING governor requests as well: a clone
  // the panic leg just revoked must not keep a place in line (the sweep would
  // otherwise grant a slot to a job that no longer exists). Lazy import for the
  // same reason as the clone leg — keep this module's import graph one-way.
  const { cancelQueuedSlots } = await import("./resource-governor");
  const cancelledSlots = await cancelQueuedSlots({ userId });

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
          cancelledSlots,
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
      cancelledSlots,
    },
  });
  return {
    expiredProposals: expiredProposals.count,
    cancelledJobs: cancelledJobs.count,
    cancelledActions: cancelledActions.count,
    policiesOff: policiesOff.count,
    clonesRevoked: cloneLeg.clonesRevoked,
    cloneSessionsStopped: cloneLeg.cloneSessionsStopped,
    cancelledSlots,
  };
}