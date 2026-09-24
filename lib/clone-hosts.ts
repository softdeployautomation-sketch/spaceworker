import "server-only";

import { db } from "./db";
import { deviceStatus } from "./devices";
import { syncDevices } from "./vantra-link";

// TASK_116 — "is there anywhere for a clone's browser to run?", in ONE place.
//
// WHY THIS MODULE EXISTS (owner report 2026-09-24: "clone host is ready, and i
// clicked start clone, and its still say no host"):
//
// The console's Device-setup card and the clone orchestrator each decided host
// availability SEPARATELY, with different liveness definitions:
//   - the card read the raw `Device.status` column;
//   - `pickHostedCloneDevice` used `deviceStatus()` (lastSeenAt within 10 min);
//   - neither refreshed the snapshot first, and that snapshot is only written
//     by `syncDevices()` — which runs when a human opens the device LIST, with
//     no timer anywhere.
//
// Measured live on device `Sc`: `status="online"`, last heartbeat **20.8 min**
// old (frozen at 17:16:21Z) — while a relay-health probe round-tripped to the
// agent **2 min earlier** and returned `up`, i.e. the machine was provably
// reachable. The card said "ready"; the gate's window had already expired; and
// because the only `clone-host` on the account WAS that device, the picker
// (which excludes the source) refused `no_hosted_clone_device`.
//
// The fix is not a wider window — that just moves the cliff. It is (a) ONE
// definition used by both sides, and (b) a liveness REFRESH from Vantra at each
// decision point, so what gets decided on is seconds old instead of however
// long ago the list was opened.

/** Refresh at most this often per user: the console polls the setup read model. */
const LIVENESS_REFRESH_THROTTLE_MS = 20_000;
const lastRefreshAt = new Map<string, number>();

/**
 * Pull the link's agent list from Vantra and upsert Device rows, so
 * `status`/`lastSeenAt` reflect reality at the moment a clone is decided.
 *
 * Best-effort by design and NEVER throws: a stale snapshot must not be able to
 * block a request. Every downstream clone step still fails closed on its own
 * device RPC, with a message that names the device.
 */
export async function refreshDeviceLiveness(userId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastRefreshAt.get(userId) ?? 0) < LIVENESS_REFRESH_THROTTLE_MS) return;
  lastRefreshAt.set(userId, now);
  try {
    await syncDevices(userId);
  } catch {
    // Best effort. The caller falls back to whatever the snapshot says.
  }
}

/**
 * Can a clone step run on this device right now?
 *
 * Deliberately accepts EITHER signal:
 *   - `deviceStatus()` — the app-wide definition (heartbeat within 10 min);
 *   - the raw `status` column — Vantra's own `online` flag, as of the refresh
 *     that just ran (TRMM's `lastSeen` can lag its own online flag, so the
 *     heartbeat alone under-reports a live machine).
 *
 * The asymmetry is intentional. A FALSE POSITIVE costs one clear
 * "device offline" from the capture/receive/launch RPC, which fails closed
 * anyway. A FALSE NEGATIVE shows the owner "no host available" with nothing to
 * click — the exact dead end this module exists to remove. `asleep` is not
 * accepted: it is an explicit state, not a freshness question.
 */
function isUsable(device: { status: string; lastSeenAt: Date | null }): boolean {
  return device.status === "online" || deviceStatus(device) === "online";
}


/** Why a clone could not find a host — drives the refusal copy and the card. */
export type HostBlockReason = "ok" | "no_host" | "self_only" | "offline";

export interface HostAvailability {
  /** A clone started here can run: an ONLINE `clone-host` exists, != source. */
  available: boolean;
  reason: HostBlockReason;
  /** Device id of the host a clone would actually use, or null. */
  pickedDeviceId: string | null;
  /** `clone-host` devices that are NOT the excluded device. */
  otherHostCount: number;
  /** ...of those, how many are online right now. */
  otherHostOnline: number;
  /**
   * Does the EXCLUDED device itself carry `clone-host`? This is the user's own
   * reading of the setup card ("I set the clone host up") — true, and still
   * unusable from here, which is exactly what the copy has to say out loud.
   */
  selfIsHost: boolean;
  /** Names of clone hosts that exist but are offline (for actionable copy). */
  offlineHostNames: string[];
}

/**
 * Single source of truth for host availability. Both the orchestrator
 * (`lib/clone.ts`) and the setup read model (`lib/clone-setup.ts`) call THIS,
 * so the card and the gate can never contradict each other again.
 */
export async function hostAvailability(opts: {
  userId: string;
  /** The source device for a clone, or the device whose console is being read. */
  excludeDeviceId: string;
}): Promise<HostAvailability> {
  const rows = await db.deviceCapability.findMany({
    where: {
      capability: "clone-host",
      enabled: true,
      device: { userId: opts.userId, vantraAgentId: { not: null } },
    },
    select: {
      device: { select: { id: true, name: true, status: true, lastSeenAt: true } },
    },
    take: 50,
  });

  const selfIsHost = rows.some((r) => r.device.id === opts.excludeDeviceId);
  const others = rows.filter((r) => r.device.id !== opts.excludeDeviceId);
  const online = others.filter((r) => isUsable(r.device));
  const offlineHostNames = others.filter((r) => !isUsable(r.device)).map((r) => r.device.name);

  const pickedDeviceId = online[0]?.device.id ?? null;
  let reason: HostBlockReason = "ok";
  if (!pickedDeviceId) {
    // `others.length === 0` + this device is a host == the user set ONE PC up
    // and is starting the clone from it. Distinct copy, because the standard
    // "click Set up as clone host" line sends them round a loop they already
    // completed (owner, 2026-09-24).
    if (others.length === 0) reason = selfIsHost ? "self_only" : "no_host";
    else reason = "offline";
  }

  return {
    available: pickedDeviceId !== null,
    reason,
    pickedDeviceId,
    otherHostCount: others.length,
    otherHostOnline: online.length,
    selfIsHost,
    offlineHostNames,
  };
}

/**
 * Auto-pick the hosted PC for a clone: `clone-host`, online, != source.
 * Thin alias over `hostAvailability` so there is exactly one query shape.
 */
export async function pickHostedCloneDevice(
  userId: string,
  excludeDeviceId: string
): Promise<string | null> {
  const availability = await hostAvailability({ userId, excludeDeviceId });
  return availability.pickedDeviceId;
}
