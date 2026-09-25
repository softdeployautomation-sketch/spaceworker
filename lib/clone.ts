import "server-only";

import type { CloneJob, Prisma } from "@prisma/client";

import { db } from "./db";
import { cloneTtlDeadlines, getCloneSettings } from "./clone-settings";
import {
  type CloneBrowser,
  type CloneEgress,
  getCloneStatus,
  mintCloneJobKey,
  probeCloneRelay,
  runCloneCapture,
  runCloneLaunch,
  runCloneReceive,
  runCloneRevoke,
} from "./clone-transport";
import { refreshDeviceLiveness, hostAvailability } from "./clone-hosts";
import { runHostedLaunch, stopHostedLaunch } from "./clone-hosted-launch";
import { ensureHostedDestination } from "./clone-destination";
import { deviceStatus, recordAgentActionAudit } from "./devices";

import { hasEntitlement, listEffectiveEntitlements } from "./entitlements";

// TASK_109 — THE CloneJob orchestrator. One module, exported functions only.
//
// It owns every CloneJob.status/launchState write and drives the pipeline
// exclusively through lib/clone-transport.ts (TASK_108) — this file never
// shells out, never speaks TRMM/Mesh/Vantra HTTP itself, never touches .env.
//
// Design decisions worth knowing (they explain the shapes below):
// - `requested` (not the schema's "pending" default) is the initial state: a
//   CloneJob only exists here because requestClone() wrote it explicitly.
//   `pending` is never used and never silently coerced into — an unknown
//   status string throws (forward-only; nothing is invented backwards).
// - Forward-only state machine: the table below is the ONLY transition
//   authority (assertCloneTransition). Terminal is terminal — no transition
//   out of it exists, and deleteClone (terminal → deleted) is the single
//   documented exception, handled outside the table.
// - advanceClone: read state → call AT MOST one transport route → persist the
//   transition. Doing-states (capturing/transferring/launching) are
//   write-ahead markers set inside the same call that runs the route, so
//   re-entering one means the previous call died mid-step: the clone fails
//   with `interrupted_<state>` instead of double-executing the step
//   (idempotency + crash safety; a possibly-running launch is best-effort
//   revoked first). A per-cloneId promise mutex serialises concurrent callers.
// - Every transition (creation, refusal, failure, revoke, expiry, panic) is
//   audited via recordAgentActionAudit (action "browser-clone") with evidence
//   only: ids, paths, counts, exit codes — never job keys/cookies/tokens.
// - Job keys are minted in memory per capture call and never stored on any
//   row, audit detail or log line (plan CROSS-TRACK RULE 2).
// - Resource governor: requestCloneSlot() is the ONE admission seam. It
//   counts CloneJobs against the TASK_107 caps today; when TASK_105 lands
//   lib/resource-governor.ts, swap ONLY that function's body for
//   requestSlot("cloneSessions", ...) — call sites stay put. The wait is
//   represented on DeviceJob.status="queued" (TASK_105 schema comment).
// - Paths are evidence: built against the engine's documented Windows layout
//   (`C:\ProgramData\TacticalRMM\Clones` — injection.DefaultStagingRoot /
//   CLONE_DEFAULTS.stagingRoot). OPEN QUESTION (TASK_108 scope, flagged not
//   improvised): moving the parcel from the source's `parcels\<id>` dir to the
//   destination's is NOT covered by the seven clone/relay routes — receive
//   consumes a local parcelDir; the byte-transfer hop needs its own route.
// - Entitlement: TASK_110 rule 2 calls it the "clone/assistant" entitlement but
//   no hasEntitlement("clone") key exists (ENTITLEMENT_KEYS has no "clone"), so
//   cloneEntitled() accepts the assistant OR devices key and denies otherwise.
// - `ready` is only reachable through the injection-validation probe
//   (getCloneStatus → engine registry check), making TASK_110's [INJECT CHECK
//   5] gate structural rather than advisory.

// State machine (the canonical union from prisma/schema.prisma TASK_97 block)
// ---------------------------------------------------------------------------

export type CloneState =
  | "requested"
  | "awaiting_source"
  | "capturing"
  | "captured"
  | "transferring"
  | "received"
  | "injecting"
  | "ready"
  | "launching"
  | "active"
  | "expired_idle"
  | "expired_hard"
  | "revoked"
  | "failed"
  | "deleted";

export const CLONE_STATES: readonly CloneState[] = [
  "requested", "awaiting_source", "capturing", "captured", "transferring",
  "received", "injecting", "ready", "launching", "active",
  "expired_idle", "expired_hard", "revoked", "failed", "deleted",
] as const;

export const CLONE_TERMINAL_STATES: readonly CloneState[] = [
  "expired_idle", "expired_hard", "revoked", "failed", "deleted",
] as const;

/**
 * The happy-path edge(s) out of each non-terminal state. Every state but one
 * has exactly one. TASK_118 B8-2: "requested" is the one exception — a
 * hosted destination skips capture/transfer/inject entirely (route 3,
 * nothing to copy) and goes straight to "ready", so it needs a SECOND valid
 * edge alongside the workstation path's "awaiting_source". Which edge a given
 * job actually takes is decided once, in stepRequested, by the destination's
 * deviceKind — this table only says which edges are LEGAL, not which one to
 * pick.
 */
const PIPELINE_NEXT: Partial<Record<CloneState, readonly CloneState[]>> = {
  requested: ["awaiting_source", "ready"],
  awaiting_source: ["capturing"],
  capturing: ["captured"],
  captured: ["transferring"],
  transferring: ["received"],
  received: ["injecting"],
  injecting: ["ready"],
  ready: ["launching"],
  launching: ["active"],
};


// ---------------------------------------------------------------------------

/**
 * States that are write-ahead markers for a transport step running inside the
 * SAME advance call. Seeing one on entry means the previous call died between
 * the marker and the outcome — fail closed, never re-execute.
 */
const IN_FLIGHT_STATES: ReadonlySet<CloneState> = new Set<CloneState>([
  "capturing",
  "transferring",
  "launching",
]);

export function isCloneState(value: string): value is CloneState {
  return (CLONE_STATES as readonly string[]).includes(value);
}

export function isCloneTerminal(status: string): status is CloneState {
  return (CLONE_TERMINAL_STATES as readonly string[]).includes(status);
}

/** Every state that may end a clone (from ANY non-terminal state). */
const ALWAYS_TERMINAL: readonly CloneState[] = [
  "expired_idle",
  "expired_hard",
  "revoked",
  "failed",
];

export function allowedCloneTransitions(from: string): readonly CloneState[] {
  if (!isCloneState(from) || isCloneTerminal(from)) return [];
  const next = PIPELINE_NEXT[from];
  return next ? [...next, ...ALWAYS_TERMINAL] : [...ALWAYS_TERMINAL];
}

/** Throws on any transition the table forbids (forward-only enforcement). */
export function assertCloneTransition(from: string, to: string): void {
  if (!allowedCloneTransitions(from).includes(to as CloneState)) {
    throw new Error(`illegal clone transition: ${from} -> ${to}`);
  }
}

export interface CloneAdvanceResult {
  cloneId: string;
  status: CloneState;
  /** Did this call move the job forward (a transition was persisted)? */
  advanced: boolean;
  /** Governor holds the job: its admission DeviceJob stays "queued". */
  queued?: boolean;
  /** Why nothing (or a terminal outcome) happened — evidence text. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal plumbing: lock, audit, transitions, evidence helpers
// ---------------------------------------------------------------------------

// Per-cloneId promise chain: two advance/revoke calls for the same clone never
// interleave their read → route → persist window (the route is only ever
// called for the state the lock-protected read saw — no double execution).
const cloneLocks = new Map<string, Promise<unknown>>();

async function withCloneLock<T>(cloneId: string, fn: () => Promise<T>): Promise<T> {
  const prev = cloneLocks.get(cloneId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const settled = next.catch(() => undefined);
  cloneLocks.set(cloneId, settled);
  try {
    return await next;
  } finally {
    if (cloneLocks.get(cloneId) === settled) cloneLocks.delete(cloneId);
  }
}

type AuditSubject = Pick<
  CloneJob,
  "id" | "userId" | "sourceDeviceId" | "destinationDeviceId" | "pendingActionId"
>;

async function auditClone(
  job: AuditSubject,
  opts: {
    status: "created" | "approved" | "rejected" | "executed" | "failed" | "expired";
    detail: Record<string, unknown>;
  }
): Promise<void> {
  await recordAgentActionAudit({
    userId: job.userId,
    pendingActionId: job.pendingActionId ?? undefined,
    action: "browser-clone",
    status: opts.status,
    sourceDeviceId: job.sourceDeviceId,
    destinationDeviceId: job.destinationDeviceId ?? undefined,
    // The STABLE CloneJob id (schema: audit rows correlate the record ↔ the
    // engine); the ENGINE clone id rides the detail map once capture makes it.
    cloneId: job.id,
    detail: opts.detail,
  });
}

/**
 * The ONLY writer of CloneJob.status (deleteClone excepted). Asserts the
 * transition, writes with an optimistic status guard (count===0 ⇒ somebody
 * else moved it concurrently ⇒ throw, never overwrite), stamps terminal
 * columns (purgeAfter / revokedAt / launchState / error / stagingRef), audits.
 */
export async function transitionClone(
  job: CloneJob,
  to: CloneState,
  opts: {
    reason?: string;
    auditStatus?: "executed" | "failed" | "expired";
    detail?: Record<string, unknown>;
    data?: Prisma.CloneJobUpdateManyMutationInput;
  } = {}
): Promise<CloneJob> {
  assertCloneTransition(job.status, to);
  const now = new Date();
  const data: Prisma.CloneJobUpdateManyMutationInput = { ...(opts.data ?? {}) };
  data.status = to;
  if (to === "failed") data.error = opts.reason ?? "failed";
  if (isCloneTerminal(to)) {
    // Purge window (TASK_112 sweeps `purgeAfter`), stamped with the CURRENT
    // setting at terminal time (a later admin change never moves it back).
    const settings = await getCloneSettings();
    data.purgeAfter = new Date(now.getTime() + settings.purgeAfterDays * 86_400_000);
    if (to === "revoked") data.revokedAt = now;
    if (to === "revoked" || to === "expired_hard" || to === "expired_idle") {
      if (job.launchState === "running" || job.launchState === "launching") {
        data.launchState = "stopped";
      }
      // Records outlive material by design: once the device-side teardown
      // confirmed (detail.teardown === "ok"), the staging pointer is cleared
      // (schema comment); on failed/skipped teardown it stays so the TASK_112
      // sweep can still find and delete the material.
      if (opts.detail?.teardown === "ok") data.stagingRef = null;
    }
  }
  const written = await db.cloneJob.updateMany({
    where: { id: job.id, status: job.status },
    data,
  });
  if (written.count === 0) {
    throw new Error(
      `clone_state_conflict: ${job.id} was not ${job.status} (concurrent transition)`
    );
  }
  await auditClone(job, {
    status: opts.auditStatus ?? "executed",
    detail: {
      from: job.status,
      to,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.detail ?? {}),
    },
  });
  return { ...job, ...(data as unknown as Partial<CloneJob>), status: to };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Engine-side Windows layout (evidence paths; mirrors Vantra CLONE_DEFAULTS).
const CLONE_WIN_ROOT = "C:\\ProgramData\\TacticalRMM\\Clones";

/** Source-side capture target (engine `clone --out` bundle dir). */
function captureOutPath(cloneJobId: string): string {
  return `${CLONE_WIN_ROOT}\\staging\\${cloneJobId}`;
}

/** Destination-side parcel dir — matches the engine's `send --out` layout. */
function parcelPath(engineCloneId: string): string {
  return `${CLONE_WIN_ROOT}\\parcels\\${engineCloneId}`;
}

/** Destination staging entry for an injected clone (fallback path). */
function stagingPath(engineCloneId: string): string {
  return `${CLONE_WIN_ROOT}\\${engineCloneId}`;
}

function isWindowsPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z]:\\[^"'`$;&|<>(){}[\]\r\n]{0,220}$/.test(value) &&
    !value.includes("..")
  );
}

const ENGINE_CLONE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Pull the engine's `clone_id` out of the capture JSON-lines evidence. */
function extractEngineCloneId(results: unknown[]): string | null {
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    for (const key of ["clone_id", "cloneId"]) {
      const value = obj[key];
      if (typeof value === "string" && ENGINE_CLONE_ID_RE.test(value)) return value;
    }
  }
  return null;
}

function extractNumber(results: unknown[], key: string): number | null {
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gates + requestClone
// ---------------------------------------------------------------------------

/** TASK_110 rule 2 — the clone/assistant entitlement (no "clone" key exists). */
async function cloneEntitled(userId: string): Promise<boolean> {
  const [assistant, devices] = await Promise.all([
    hasEntitlement(userId, "assistant"),
    hasEntitlement(userId, "devices"),
  ]);
  return assistant.allowed || devices.allowed;
}

/**
 * THE admission seam (TASK_105 hand-off point). Counts live clone SESSIONS —
 * `active` jobs hold a slot; queued/pipeline jobs wait. When
 * lib/resource-governor.ts exists, replace ONLY this body with
 * requestSlot("cloneSessions", { userId }) and keep the return shape.
 */
async function requestCloneSlot(
  userId: string,
  settings: Awaited<ReturnType<typeof getCloneSettings>>
): Promise<{ granted: boolean; reason?: string }> {
  if (!settings.enabled) return { granted: false, reason: "clone_sessions_paused" };
  const live = await db.cloneJob.count({ where: { status: "active" } });
  if (live >= settings.maxConcurrent) {
    return { granted: false, reason: `at_capacity (${live}/${settings.maxConcurrent})` };
  }
  const perUser = await db.cloneJob.count({ where: { userId, status: "active" } });
  if (perUser >= settings.perUserCap) {
    return { granted: false, reason: `per_user_cap (${perUser}/${settings.perUserCap})` };
  }
  return { granted: true };
}

/**
 * Host availability now lives in `lib/clone-hosts.ts` so the console's
 * Device-setup card and this gate share ONE definition of "a host is
 * available" — see that file for the 2026-09-24 owner report that made the
 * split expensive.
 */

export interface RequestCloneInput {
  userId: string;
  /** Device A — the work PC the profile is captured from. */
  sourceDeviceId: string;
  /** Device B — explicit pick; otherwise auto-resolved from the hosted pool. */
  destinationDeviceId?: string;
  egress: CloneEgress;
  browser?: CloneBrowser;
  profile?: string;
  pendingActionId?: string;
  /** TASK_119: session delivery mode. "fresh" (default, route 3) | "live" (new, carries user's session via CDP). */
  sessionMode?: "fresh" | "live";
}

export interface RequestCloneResult {
  cloneId: string;
  status: CloneState;
  /** True when TASK_105's governor held the job — 202, DeviceJob stays queued. */
  queued: boolean;
  queueReason?: string;
}

const PROFILE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Creates the CloneJob (+ its queued admission DeviceJob) after every gate.
 * Refusals are audited (`rejected`) and thrown with the user-facing reason —
 * TASK_110's route maps them to 403 with the same text.
 */
export async function requestClone(input: RequestCloneInput): Promise<RequestCloneResult> {
  const userId = input.userId;
  const sourceDeviceId = input.sourceDeviceId;
  const settings = await getCloneSettings();

  const refuse = async (code: string, message: string): Promise<never> => {
    await recordAgentActionAudit({
      userId,
      pendingActionId: input.pendingActionId,
      action: "browser-clone",
      status: "rejected",
      sourceDeviceId,
      destinationDeviceId: input.destinationDeviceId,
      detail: { reason: code, egress: input.egress, message },
    });
    throw new Error(message);
  };

  if (input.egress !== "relay" && input.egress !== "direct") {
    return refuse("bad_egress", "Egress must be relay (same IP) or direct.");
  }
  if (input.browser && !["chrome", "edge", "firefox"].includes(input.browser)) {
    return refuse("bad_browser", "Unsupported browser for a clone.");
  }
  if (input.profile && !PROFILE_NAME_RE.test(input.profile)) {
    return refuse(
      "bad_profile",
      "Profile name may only contain letters, digits, dot, dash or underscore (max 64)."
    );
  }
  // TASK_119: sessionMode validation (fresh is default).
  if (input.sessionMode && !["fresh", "live"].includes(input.sessionMode)) {
    return refuse("bad_session_mode", "Session mode must be 'fresh' or 'live'.");
  }

  // 1. Admin pause blocks NEW clone starts; live sessions are untouched.
  if (!settings.enabled) {
    return refuse("clone_sessions_paused", "Browser clone is paused by the administrator — no new clones can start right now.");
  }
  // 2. Entitlement (clone/assistant family — see cloneEntitled above).
  if (!(await cloneEntitled(userId))) {
    return refuse("no_entitlement", "Browser Clone is not included in your current plan — upgrade to continue.");
  }
  // 3. Direct egress is premium + explicit (never a silent fallback anyway).
  if (input.egress === "direct" && settings.directEgressPremiumOnly) {
    const { premium } = await listEffectiveEntitlements(userId);
    if (!premium) {
      return refuse("direct_requires_premium", "Direct egress (hosted-PC IP) is a Premium feature — use same-IP relay mode, or upgrade to Premium.");
    }
  }

  // 4. Source device: owned + linked to the agent (capture runs there).
  //
  // TASK_116 — refresh liveness from Vantra FIRST. `Device.status`/`lastSeenAt`
  // are only written by `syncDevices()`, which has no timer and runs when a
  // human opens the device list; the host pick below applies a 10-minute
  // freshness window to that snapshot. Measured live (device `Sc`): heartbeat
  // 20.8 min stale while a relay probe round-tripped to the agent 2 min
  // earlier — so the gate could refuse `no_hosted_clone_device` for a machine
  // that was demonstrably up. Best-effort and throttled; never throws.
  await refreshDeviceLiveness(userId);

  const source = await db.device.findUnique({
    where: { id: sourceDeviceId },
    select: { id: true, userId: true, name: true, status: true, lastSeenAt: true, vantraAgentId: true },
  });
  if (!source || source.userId !== userId) {
    return refuse("source_device_not_owned", "That source device does not belong to your account.");
  }
  if (!source.vantraAgentId) {
    return refuse("source_device_not_linked", "That device is not linked to the agent yet — link it before cloning from it.");
  }

  // 5. Relay mode needs a registered RelayHealth row on the source (the
  //    health PROBE happens at advance time, before capture — fail closed).
  let relayId: string | null = null;
  if (input.egress === "relay") {
    const relay = await db.relayHealth.findUnique({ where: { deviceId: sourceDeviceId } });
    if (!relay || relay.userId !== userId) {
      return refuse(
        "relay_not_registered",
        // Owner 2026-09-24: the old tail ("or choose direct egress if your plan
        // allows it") sent a Premium owner to a DIFFERENT refusal, because the
        // clone's browser needs a clone host either way. Point at the button
        // that fixes this instead. The leading phrase is load-bearing: it is
        // what REFUSALS matches in app/api/devices/[deviceId]/clones/route.ts.
        "No egress relay is registered on that device — in the Device setup card above, click \"Set up this PC\" (one click, nothing to install by hand), then start the clone again."
      );
    }
    relayId = relay.id;
  }

  // 6. Destination device B: explicit pick must be owned and usable; otherwise
  //    auto-pick our HOSTED browser (or the user's own clone-host workstation).
  //
  // TASK_118 B8-1: the destination row is created here (and in the setup read
  // model) so the picker always has something real to select. Before this, the
  // row was read in one place and written nowhere, so the pool was permanently
  // 0 and Start always answered "no hosted clone PC is available".
  const hostedDestinationId = await ensureHostedDestination(userId);
  let destinationDeviceId: string | null = input.destinationDeviceId ?? null;
  if (destinationDeviceId) {
    const dest = await db.device.findUnique({
      where: { id: destinationDeviceId },
      select: { id: true, userId: true, vantraAgentId: true, deviceKind: true },
    });
    if (!dest || dest.userId !== userId) {
      return refuse("destination_device_not_owned", "That destination device does not belong to your account.");
    }
    if (destinationDeviceId === sourceDeviceId) {
      return refuse(
        "same_device",
        "A clone cannot run on the same PC it captures from — the copied browser runs on SpaceWorker's hosted browser instead. Pick that, or another clone host."
      );
    }
    // A HOSTED destination is our own browser (TASK_118 B8-1): it has no agent
    // and carries no `clone-host` capability by design, so the two checks below
    // must not apply to it — they are what made an explicit hosted pick
    // impossible. A WORKSTATION destination still has to prove both.
    if (dest.deviceKind !== "hosted") {
      if (!dest.vantraAgentId) {
        return refuse("destination_device_not_linked", "The destination device is not linked to the agent yet.");
      }
      const cap = await db.deviceCapability.findFirst({
        where: { deviceId: destinationDeviceId, capability: "clone-host", enabled: true },
      });
      if (!cap) {
        return refuse("destination_not_clone_host", "The destination device must be a clone host (clone-host capability enabled).");
      }
    }
  } else {
    const hosts = await hostAvailability({ userId, excludeDeviceId: sourceDeviceId });
    // Never lose the destination we just ensured: if the picker somehow saw an
    // empty pool (e.g. its query ran before the row existed), fall back to the
    // hosted row rather than refusing on a technicality.
    destinationDeviceId = hosts.pickedDeviceId ?? hostedDestinationId;
  }

  // Create the record. TTLs are STAMPED from the settings at creation
  // (idle refreshed at activation; hard ceiling absolute) so a later admin
  // change never retroactively expires a running clone.
  const browser: CloneBrowser = input.browser ?? "chrome";
  const ttl = cloneTtlDeadlines(settings);
  const sessionMode = input.sessionMode ?? "fresh";
  const job = await db.cloneJob.create({
    data: {
      userId,
      sourceDeviceId,
      destinationDeviceId,
      relayId,
      status: "requested",
      launchState: "not_launched",
      pendingActionId: input.pendingActionId ?? null,
      browser,
      profileName: input.profile ?? null,
      // Requested policy until launch; launch overwrites with the mode that
      // ACTUALLY ran (never inferred).
      egressMode: input.egress,
      sessionMode,
      idleExpiresAt: ttl.idleExpiresAt,
      expiresAt: ttl.expiresAt,
    },
  });

  // The admission DeviceJob (TASK_105 queue representation): created queued,
  // closed when the governor grants the slot.
  const admissionJob = await db.deviceJob.create({
    data: {
      userId,
      deviceId: sourceDeviceId,
      jobType: "browser-clone:request",
      status: "queued",
      payload: { cloneId: job.id, step: "admission" },
    },
  });

  const slot = await requestCloneSlot(userId, settings);
  if (slot.granted) {
    await db.deviceJob.updateMany({
      where: { id: admissionJob.id, status: "queued" },
      data: { status: "succeeded", finishedAt: new Date(), result: { slot: "granted", cloneId: job.id } },
    });
  }

  await auditClone(job, {
    status: "created",
    detail: {
      reason: "requested",
      egress: input.egress,
      browser,
      destinationDeviceId,
      slot: slot.granted ? "granted" : "queued",
      ...(slot.reason ? { queueReason: slot.reason } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
    },
  });

  return {
    cloneId: job.id,
    status: "requested",
    queued: !slot.granted,
    ...(slot.granted ? {} : { queueReason: slot.reason }),
  };
}

// ---------------------------------------------------------------------------
// advanceClone — the state machine driver (exactly one route per call)
// ---------------------------------------------------------------------------

type CloneJobWithRelay = CloneJob & { relay: { addr: string; status: string } | null };

async function loadClone(cloneId: string): Promise<CloneJobWithRelay> {
  const job = await db.cloneJob.findUnique({
    where: { id: cloneId },
    include: { relay: { select: { addr: true, status: true } } },
  });
  if (!job) throw new Error(`clone ${cloneId} not found`);
  return job as CloneJobWithRelay;
}

/**
 * Advance a clone by (at most) one step. Safe to re-enter at any time:
 * - terminal → no-op (returns { advanced:false, reason:"terminal" });
 * - doing-state → the previous call died mid-step: fail with
 *   `interrupted_<state>` instead of double-executing (best-effort revoke
 *   first when a launch may have left a browser running);
 * - concurrent calls are serialised per cloneId, so the route is invoked only
 *   for the state the protected read saw.
 */
export async function advanceClone(cloneId: string): Promise<CloneAdvanceResult> {
  return withCloneLock(cloneId, () => advanceCloneLocked(cloneId));
}

async function advanceCloneLocked(cloneId: string): Promise<CloneAdvanceResult> {
  const job = await loadClone(cloneId);
  const state = job.status;
  if (!isCloneState(state)) {
    // Forward-only: `pending` (or anything else) is never coerced into a real
    // state — the explicit requestClone() write is the only entry point.
    throw new Error(`clone ${cloneId} has unknown state "${state}" — refusing to coerce`);
  }
  if (isCloneTerminal(state)) {
    return { cloneId, status: state, advanced: false, reason: "terminal" };
  }
  if (IN_FLIGHT_STATES.has(state)) {
    // Crash between the write-ahead marker and the step outcome. For launch
    // the engine may have started a browser we never observed — tear down
    // best-effort before failing the record (same switch, no side channel).
    let teardown = "skipped";
    // TASK_118 B8-2: dropped the `&& job.cloneId` requirement — a hosted
    // clone never has one (route 3 skips capture), and teardownTransport
    // itself already handles hosted vs. cloneId correctly internally; gating
    // on it here would silently skip a crashed hosted launch's teardown.
    if (state === "launching" && job.destinationDeviceId) {
      teardown = await teardownTransport(job, job.destinationDeviceId);
    }
    const reason = `interrupted_${state} (advance re-entered an in-flight step; step not re-executed)`;
    await transitionClone(job, "failed", { reason, auditStatus: "failed", detail: { teardown } });
    return { cloneId, status: "failed", advanced: true, reason };
  }

  const settings = await getCloneSettings();
  switch (state) {
    case "requested":
      return stepRequested(job, settings);
    case "awaiting_source":
      return stepCapture(job);
    case "captured":
      return stepTransfer(job);
    case "received":
      return stepValidateInjection(job);
    case "injecting":
      // Resumable: the validation probe is read-only (no lifecycle writes), so
      // re-entering after a crash can only move the clone to ready or failed.
      return validateInjected(job);
    case "ready":
      return stepLaunch(job, settings);
    case "active":
      return { cloneId, status: "active", advanced: false, reason: "session_active" };
    default:
      throw new Error(`clone ${cloneId}: unhandled state ${state}`);
  }
}

/** Best-effort device-side teardown; returns "ok" | "skipped" | "error: ...". */
async function teardownTransport(job: CloneJob, destinationDeviceId: string): Promise<string> {
  // TASK_118 B8-2 — checked BEFORE the cloneId guard below: a hosted clone
  // NEVER has an engine cloneId (route 3 skips capture entirely), so the old
  // "no cloneId -> skipped" early return would have silently no-op'd every
  // hosted teardown — the session/relay-listener would never actually stop.
  // A hosted destination has no agent either way, so runCloneRevoke (an
  // agent RPC) would just fail on one; stopHostedLaunch is the real
  // teardown, and it's a documented no-op if the session never started
  // (browser-server's stopInternal + deleteProfileDir).
  const destination = await db.device.findUnique({
    where: { id: destinationDeviceId },
    select: { deviceKind: true },
  });
  if (destination?.deviceKind === "hosted") {
    return stopHostedLaunch(job.id);
  }
  if (!job.cloneId) return "skipped";
  try {
    const res = await runCloneRevoke({
      userId: job.userId,
      cloneJobId: job.id,
      pendingActionId: job.pendingActionId ?? undefined,
      deviceId: destinationDeviceId,
      sourceDeviceId: job.sourceDeviceId,
      destinationDeviceId,
      cloneId: job.cloneId,
      browser: job.browser as CloneBrowser,
    });
    return res.ok
      ? "ok"
      : `error: revoke not ok (remaining=${res.browserProcessesRemaining ?? "unknown"})`;
  } catch (err) {
    return `error: ${errMessage(err)}`;
  }
}

/** Probe result → RelayHealth row (the documented refreshRelayHealth seam). */
async function stampRelayHealth(
  deviceId: string,
  probe: { status: "up" | "down" } | null
): Promise<void> {
  const row = await db.relayHealth.findUnique({
    where: { deviceId },
    select: { id: true, consecutiveFailures: true },
  });
  if (!row) return;
  const now = new Date();
  await db.relayHealth.update({
    where: { id: row.id },
    data: probe
      ? {
          status: probe.status,
          lastCheckAt: now,
          ...(probe.status === "up"
            ? { lastSeenAt: now, consecutiveFailures: 0 }
            : { consecutiveFailures: row.consecutiveFailures + 1 }),
        }
      : { status: "down", lastCheckAt: now, consecutiveFailures: row.consecutiveFailures + 1 },
  });
}

/** requested → awaiting_source (admission → online → relay probe; no capture yet). */
async function stepRequested(
  job: CloneJobWithRelay,
  settings: Awaited<ReturnType<typeof getCloneSettings>>
): Promise<CloneAdvanceResult> {
  const base = { cloneId: job.id };

  // Pause blocks NEW starts — a waiting clone waits too.
  if (!settings.enabled) {
    return { ...base, status: "requested", advanced: false, reason: "clone_sessions_paused" };
  }

  // Governor admission (TASK_105 seam): re-checked on every sweep until the
  // slot is granted; the wait itself rides DeviceJob.status="queued".
  const queuedAdmission = await db.deviceJob.findFirst({
    where: {
      userId: job.userId,
      deviceId: job.sourceDeviceId,
      jobType: "browser-clone:request",
      status: "queued",
    },
  });
  const ownsAdmission =
    !!queuedAdmission &&
    !!queuedAdmission.payload &&
    typeof queuedAdmission.payload === "object" &&
    (queuedAdmission.payload as { cloneId?: unknown }).cloneId === job.id;
  const slot = await requestCloneSlot(job.userId, settings);
  if (!slot.granted) {
    if (!ownsAdmission) {
      await db.deviceJob.create({
        data: {
          userId: job.userId,
          deviceId: job.sourceDeviceId,
          jobType: "browser-clone:request",
          status: "queued",
          payload: { cloneId: job.id, step: "admission" },
        },
      });
    }
    return { ...base, status: "requested", advanced: false, queued: true, reason: slot.reason };
  }
  if (ownsAdmission && queuedAdmission) {
    await db.deviceJob.updateMany({
      where: { id: queuedAdmission.id, status: "queued" },
      data: { status: "succeeded", finishedAt: new Date(), result: { slot: "granted", cloneId: job.id } },
    });
  }

  // Capture runs ON the source — it must be online regardless of egress mode.
  const source = await db.device.findUnique({
    where: { id: job.sourceDeviceId },
    select: { id: true, status: true, lastSeenAt: true, vantraAgentId: true },
  });
  if (!source) {
    const reason = "source_device_missing";
    await transitionClone(job, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  if (deviceStatus(source) !== "online") {
    return { ...base, status: "requested", advanced: false, reason: "source_offline" };
  }

  // Relay gate: probe EXACTLY once here, before capture. Fail closed when the
  // relay is unhealthy — a refusal naming the relay, never a silent downgrade
  // (cloneRelayRequired=false is the admin's explicit escape hatch; the egress
  // policy stays "relay" either way and the engine re-checks [IP CHECK 2]).
  if (job.egressMode === "relay" && job.relay) {
    let probe: Awaited<ReturnType<typeof probeCloneRelay>> | null = null;
    let probeError: string | null = null;
    try {
      probe = await probeCloneRelay({
        userId: job.userId,
        cloneJobId: job.id,
        sourceDeviceId: job.sourceDeviceId,
      });
    } catch (err) {
      probeError = errMessage(err);
    }
    await stampRelayHealth(job.sourceDeviceId, probe);
    const unhealthy = probe?.status !== "up";
    if (unhealthy && settings.relayRequired) {
      const reason = probe
        ? `relay_unhealthy: egress relay on ${job.relay.addr} probed "${probe.status}" — relay must be up before capture`
        : `relay_unreachable: ${probeError ?? "probe failed"} — relay must be up before capture`;
      await transitionClone(job, "failed", {
        reason,
        auditStatus: "failed",
        detail: { relayAddr: job.relay.addr, relayStatus: probe?.status ?? "down" },
      });
      return { ...base, status: "failed", advanced: true, reason };
    }
  }

  // TASK_118 B8-2 — a HOSTED destination has nothing to capture, transfer or
  // inject: route 3 (TASK_117's settled design) is "the hosted browser logs
  // in for itself," not a copied profile. Skip capture/transfer/inject
  // entirely and land straight on "ready" so the next advance is stepLaunch.
  // A workstation destination is completely unaffected — same path as before
  // this task. (Found live: without this branch, a hosted clone ran the full
  // agent-capture pipeline anyway and failed at capture_no_clone_id — there
  // was never a bundle for it to produce.)
  // TASK_119A V9: live jobs with hosted destination must wait for capture
  // to arrive before launching, so they go to awaiting_source, not ready.
  const destination = job.destinationDeviceId
    ? await db.device.findUnique({ where: { id: job.destinationDeviceId }, select: { deviceKind: true } })
    : null;
  if (destination?.deviceKind === "hosted" && job.sessionMode !== "live") {
    const advanced = await transitionClone(job, "ready", {
      detail: {
        slot: "granted",
        egressMode: job.egressMode,
        relayStatus: job.relay?.status ?? null,
        skipped: "capture_transfer_inject (hosted destination, route 3 — nothing to copy)",
      },
    });
    return { cloneId: advanced.id, status: "ready", advanced: true };
  }

  const advanced = await transitionClone(job, "awaiting_source", {
    detail: {
      slot: "granted",
      egressMode: job.egressMode,
      relayStatus: job.relay?.status ?? null,
    },
  });
  return { cloneId: advanced.id, status: "awaiting_source", advanced: true };
}

/** awaiting_source → capturing (marker) → captured | failed. One route: capture. */
async function stepCapture(job: CloneJob): Promise<CloneAdvanceResult> {
  const base = { cloneId: job.id };
  // Write-ahead marker: crash between here and the route outcome ⇒ next
  // entry fails with interrupted_capturing (never double-captures).
  const cur = await transitionClone(job, "capturing", { detail: { step: "capture" } });

  // Key lives in THIS call's memory only — passed through the transport into
  // the child env, never written to any row, audit detail or log.
  const jobKey = mintCloneJobKey();
  let res;
  try {
    res = await runCloneCapture({
      userId: job.userId,
      cloneJobId: job.id,
      pendingActionId: job.pendingActionId ?? undefined,
      sourceDeviceId: job.sourceDeviceId,
      browser: job.browser as CloneBrowser,
      outPath: captureOutPath(job.id),
      profile: job.profileName ?? undefined,
      jobKey,
    });
  } catch (err) {
    const reason = `transport_error: ${errMessage(err)}`;
    const failed = await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
    });
    return { cloneId: failed.id, status: "failed", advanced: true, reason };
  }

  // A partial capture is NEVER success (MT-1 F2: silent partial ship).
  if (res.partial || res.exitCode !== 0 || !res.ok) {
    const reason = `capture_exit_${res.exitCode ?? "unknown"}${res.partial ? " (partial)" : ""}`;
    await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
      detail: { step: "capture", exitCode: res.exitCode, partial: res.partial },
    });
    return { ...base, status: "failed", advanced: true, reason };
  }

  const engineCloneId = extractEngineCloneId(res.results);
  if (!engineCloneId) {
    // No engine registry id ⇒ no transferable bundle identity — fail closed.
    const reason = "capture_no_clone_id (capture output carried no engine clone id)";
    await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
      detail: { step: "capture", exitCode: res.exitCode },
    });
    return { ...base, status: "failed", advanced: true, reason };
  }

  const fileCount = extractNumber(res.results, "files");
  const done = await transitionClone(cur, "captured", {
    detail: {
      step: "capture",
      exitCode: res.exitCode,
      engineCloneId,
      ...(fileCount !== null ? { fileCount } : {}),
    },
    data: {
      cloneId: engineCloneId,
      captureExitCode: res.exitCode ?? 0,
      ...(fileCount !== null ? { fileCount } : {}),
    },
  });
  return { cloneId: done.id, status: "captured", advanced: true };
}

/** captured → transferring (marker) → received | failed. One route: receive. */
async function stepTransfer(job: CloneJob): Promise<CloneAdvanceResult> {
  const base = { cloneId: job.id };
  if (!job.destinationDeviceId) {
    const reason = "no_destination_device";
    await transitionClone(job, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  if (!job.cloneId) {
    const reason = "no_engine_clone_id";
    await transitionClone(job, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  // Write-ahead marker (same crash rule as capture).
  const cur = await transitionClone(job, "transferring", { detail: { step: "receive" } });

  // NOTE (open question, flagged not improvised): this drives Vantra's
  // receive+inject against a LOCAL parcelDir on the destination. The byte hop
  // source→destination is not covered by TASK_108's seven routes; the parcel
  // is expected at the canonical engine layout (parcels\<id>) when receive runs.
  let res;
  try {
    res = await runCloneReceive({
      userId: job.userId,
      cloneJobId: job.id,
      pendingActionId: job.pendingActionId ?? undefined,
      destinationDeviceId: job.destinationDeviceId,
      cloneId: job.cloneId,
      parcelDir: parcelPath(job.cloneId),
      hostBrowser: job.browser as CloneBrowser,
    });
  } catch (err) {
    const reason = `transport_error: ${errMessage(err)}`;
    await transitionClone(cur, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  if (!res.ok) {
    const reason = "receive_failed (parcel receive/inject not ok on the destination)";
    await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
      detail: { step: "receive", received: res.received, injected: res.injected },
    });
    return { ...base, status: "failed", advanced: true, reason };
  }

  // stagingRef = where the material now lives on the HOSTED PC (schema
  // comment); cleared later when teardown confirms (transitionClone).
  const stagingRef = isWindowsPath(res.injected)
    ? res.injected
    : stagingPath(job.cloneId);
  const done = await transitionClone(cur, "received", {
    detail: { step: "receive", stagingRef },
    data: { stagingRef },
  });
  return { cloneId: done.id, status: "received", advanced: true };
}

/** received → injecting → ready | failed. One route: status ([INJECT CHECK 5]). */
async function stepValidateInjection(job: CloneJob): Promise<CloneAdvanceResult> {
  // `injecting` marks "injection ran inside the receive call; validation of
  // the engine registry entry pending" — `ready` is unreachable without it.
  const cur = await transitionClone(job, "injecting", { detail: { step: "inject-validate" } });
  return validateInjected(cur);
}

/**
 * The validation half, split out so a clone found in `injecting` (process died
 * between the marker and the outcome) RESUMES here instead of failing: the
 * probe is read-only (getCloneStatus writes no lifecycle rows), so re-running
 * it is idempotent — it can only ever move the clone to `ready` or `failed`.
 */
async function validateInjected(job: CloneJob): Promise<CloneAdvanceResult> {
  const base = { cloneId: job.id };
  const cur = job;
  if (!job.destinationDeviceId || !job.cloneId) {
    const reason = "inject_validation_skipped: no destination/engine id";
    await transitionClone(cur, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  let res;
  try {
    res = await getCloneStatus({
      userId: job.userId,
      cloneJobId: job.id,
      pendingActionId: job.pendingActionId ?? undefined,
      deviceId: job.destinationDeviceId,
      cloneId: job.cloneId,
    });
  } catch (err) {
    const reason = `inject_validation_error: ${errMessage(err)}`;
    await transitionClone(cur, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  if (!res.ok) {
    const reason = "inject_validation_failed ([INJECT CHECK 5]: clone not registered/ready on the destination)";
    await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
      detail: { step: "inject-validate", statusOk: res.ok, statusExitCode: res.exitCode, registryEntries: res.entries.length },
    });
    return { ...base, status: "failed", advanced: true, reason };
  }
  const done = await transitionClone(cur, "ready", {
    detail: { step: "inject-validate", statusOk: res.ok, statusExitCode: res.exitCode, registryEntries: res.entries.length },
  });
  return { cloneId: done.id, status: "ready", advanced: true };
}

/** ready → launching (marker) → active | failed. One route: launch. */
async function stepLaunch(
  job: CloneJobWithRelay,
  settings: Awaited<ReturnType<typeof getCloneSettings>>
): Promise<CloneAdvanceResult> {
  const base = { cloneId: job.id };
  if (!job.destinationDeviceId) {
    const reason = "no_destination_device";
    await transitionClone(job, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  // TASK_118 B8-2 — a HOSTED destination (our own browser) has no agent, so
  // it must never go through the agent-RPC path (runCloneLaunch) at all —
  // that call would just 404/fail on a device with no vantraAgentId. Branch
  // on the destination's actual kind, not on egress mode: both relay and
  // direct clones can land on a hosted destination. Checked BEFORE the
  // cloneId guard below: `job.cloneId` is the ENGINE's own id, assigned
  // during capture — a hosted job never captures (route 3, skipped in
  // stepRequested), so it never has one and never needs one.
  const destination = await db.device.findUnique({
    where: { id: job.destinationDeviceId },
    select: { deviceKind: true },
  });
  const isHostedDestination = destination?.deviceKind === "hosted";
  if (!isHostedDestination && !job.cloneId) {
    const reason = "no_destination_device";
    await transitionClone(job, "failed", { reason, auditStatus: "failed" });
    return { ...base, status: "failed", advanced: true, reason };
  }
  // Pause blocks NEW session starts (live ones are untouched).
  if (!settings.enabled) {
    return { ...base, status: "ready", advanced: false, reason: "clone_sessions_paused" };
  }
  // Governor re-check right before a session materialises (a queue may have
  // drained while the clone was being built — still the TASK_105 seam).
  const slot = await requestCloneSlot(job.userId, settings);
  if (!slot.granted) {
    return { ...base, status: "ready", advanced: false, queued: true, reason: slot.reason };
  }

  const cur = await transitionClone(job, "launching", {
    detail: { step: "launch" },
    data: { launchState: "launching" },
  });

  const relayAddr = job.egressMode === "relay" ? job.relay?.addr ?? undefined : undefined;
  let res: { ok: boolean; exitCode: number | null; egressMode: string; viewUrl?: string; egressIp?: string };
  try {
    res = isHostedDestination
      ? await runHostedLaunch({
          userId: job.userId,
          cloneJobId: job.id,
          sourceDeviceId: job.sourceDeviceId,
          egress: job.egressMode as CloneEgress,
        })
      : await runCloneLaunch({
          userId: job.userId,
          cloneJobId: job.id,
          pendingActionId: job.pendingActionId ?? undefined,
          sourceDeviceId: job.sourceDeviceId,
          destinationDeviceId: job.destinationDeviceId,
          // Non-null: the guard above already required job.cloneId for every
          // non-hosted path (this branch), and this job is not hosted here.
          cloneId: job.cloneId!,
          egress: job.egressMode as CloneEgress,
          relayAddr,
        });
  } catch (err) {
    const reason = `transport_error: ${errMessage(err)}`;
    await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
      data: { launchState: "not_launched" },
    });
    return { ...base, status: "failed", advanced: true, reason };
  }
  if (!res.ok) {
    const reason = `launch_exit_${res.exitCode ?? "unknown"} (launch not ok)`;
    await transitionClone(cur, "failed", {
      reason,
      auditStatus: "failed",
      detail: { step: "launch", exitCode: res.exitCode, egress: job.egressMode },
      data: { launchState: "not_launched" },
    });
    return { ...base, status: "failed", advanced: true, reason };
  }

  // The mode that ACTUALLY ran, straight from the launch result — written to
  // the CloneJob + the audit below, never inferred (TASK_97 deliverable 9).
  const usedEgress = res.egressMode as CloneEgress;
  const now = new Date();
  const idleExpiresAt = new Date(now.getTime() + settings.idleTtlMinutes * 60_000);
  const done = await transitionClone(cur, "active", {
    detail: {
      step: "launch",
      exitCode: res.exitCode,
      egressMode: usedEgress,
      idleExpiresAt: idleExpiresAt.toISOString(),
    },
    data: {
      launchState: "running",
      egressMode: usedEgress,
      lastUsedAt: now,
      idleExpiresAt,
    },
  });

  // HostedBrowserSession row (truth: what launched). upsert on the unique
  // cloneJobId so re-runs update rather than fork a session record.
  // TASK_118 B8-2 fix: viewUrl was never stamped (Cline's own B8-2 finding —
  // "the clone window loads forever") — a hosted launch's viewUrl/egressIp
  // are the actual evidence of what got built, so write them here, not just
  // status/egressMode. A workstation-destination launch leaves both null,
  // same as before this task.
  await db.hostedBrowserSession.upsert({
    where: { cloneJobId: job.id },
    create: {
      userId: job.userId,
      deviceId: job.destinationDeviceId,
      cloneJobId: job.id,
      status: "running",
      egressMode: usedEgress,
      viewUrl: res.viewUrl ?? null,
      egressIp: res.egressIp ?? null,
      startedAt: now,
      lastUsedAt: now,
      expiresAt: job.expiresAt,
    },
    update: {
      status: "running",
      egressMode: usedEgress,
      viewUrl: res.viewUrl ?? null,
      egressIp: res.egressIp ?? null,
      lastUsedAt: now,
      stoppedAt: null,
      error: null,
    },
  });

  return { cloneId: done.id, status: "active", advanced: true };
}

// ---------------------------------------------------------------------------
// Termination: revoke / expire / panic / delete
// ---------------------------------------------------------------------------

export interface RevokeCloneResult {
  cloneId: string;
  status: CloneState;
  revoked: boolean;
  reason?: string;
}

/**
 * User- or system-initiated revoke: device teardown (best-effort, result
 * recorded as evidence — the RECORD still goes terminal either way), session
 * stop, terminal `revoked`. Idempotent: revoking twice reports `revoked:false`.
 */
export async function revokeClone(
  cloneId: string,
  actor = "user"
): Promise<RevokeCloneResult> {
  return withCloneLock(cloneId, async () => {
    const job = await loadClone(cloneId);
    if (isCloneTerminal(job.status)) {
      return {
        cloneId,
        status: job.status as CloneState,
        revoked: false,
        reason: job.status === "revoked" ? "already_revoked" : `already_terminal (${job.status})`,
      };
    }
    const teardown = job.destinationDeviceId
      ? await teardownTransport(job, job.destinationDeviceId)
      : "skipped";
    const done = await terminalEndClone(job, "revoked", {
      actor,
      reason: `revoked_by_${actor}`,
      teardown,
    });
    return { cloneId, status: done.status as CloneState, revoked: true };
  });
}

/**
 * Shared terminal writer for revoke/expiry/panic: stops every session row of
 * the clone, then runs the audited `→ <terminal>` transition.
 */
async function terminalEndClone(
  job: CloneJob,
  to: "revoked" | "expired_idle" | "expired_hard",
  opts: { actor?: string; reason: string; teardown: string }
): Promise<CloneJob> {
  const stopped = await db.hostedBrowserSession.updateMany({
    where: { cloneJobId: job.id, status: { in: ["starting", "running"] } },
    data: { status: "stopped", stoppedAt: new Date() },
  });
  return transitionClone(job, to, {
    reason: opts.reason,
    auditStatus: to === "revoked" ? "executed" : "expired",
    detail: {
      ...(opts.actor ? { actor: opts.actor } : {}),
      teardown: opts.teardown,
      sessionsStopped: stopped.count,
    },
  });
}

export interface ExpireClonesResult {
  scanned: number;
  expiredIdle: number;
  expiredHard: number;
  errors: number;
}

/**
 * TTL sweep (the expiry half of TASK_112's sweep): any non-terminal clone
 * past its idle or hard stamp is torn down and stamped terminal with WHICH
 * TTL fired. Idempotent — it only ever selects non-terminal rows.
 */
export async function expireClones(): Promise<ExpireClonesResult> {
  const now = new Date();
  const due = await db.cloneJob.findMany({
    where: {
      status: { notIn: [...CLONE_TERMINAL_STATES] },
      OR: [{ idleExpiresAt: { lte: now } }, { expiresAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const out: ExpireClonesResult = {
    scanned: due.length,
    expiredIdle: 0,
    expiredHard: 0,
    errors: 0,
  };

  for (const job of due) {
    // Hard TTL wins the race (absolute even while in use).
    const hard = job.expiresAt !== null && job.expiresAt <= now;
    const target = hard ? ("expired_hard" as const) : ("expired_idle" as const);
    const reason = hard
      ? "hard TTL expired (cloneHardTtlMinutes ceiling)"
      : "idle TTL expired (cloneIdleTtlMinutes without activity)";
    try {
      await withCloneLock(job.id, async () => {
        const fresh = await loadClone(job.id);
        if (isCloneTerminal(fresh.status)) return; // raced with revoke/etc.
        const teardown = fresh.destinationDeviceId
          ? await teardownTransport(fresh, fresh.destinationDeviceId)
          : "skipped";
        await terminalEndClone(fresh, target, { actor: "system", reason, teardown });
        if (hard) out.expiredHard += 1;
        else out.expiredIdle += 1;
      });
    } catch (err) {
      out.errors += 1;
      await recordAgentActionAudit({
        userId: job.userId,
        pendingActionId: job.pendingActionId ?? undefined,
        action: "browser-clone",
        status: "failed",
        sourceDeviceId: job.sourceDeviceId,
        destinationDeviceId: job.destinationDeviceId ?? undefined,
        cloneId: job.id,
        detail: { reason: `expire_error: ${errMessage(err)}` },
      });
    }
  }
  return out;
}

export interface PanicCloneCounts {
  clonesRevoked: number;
  cloneSessionsStopped: number;
  errors: number;
}

/**
 * The panic switch's clone leg (lib/devices.ts::panicStopAllDevices calls this
 * via a lazy import — ONE switch, no isolated revocation path). Stops every
 * remaining session row of the user outright, then revokes every non-terminal
 * clone through the SAME transport-revoke + transitionClone audit path.
 */
export async function revokeClonesForPanic(
  userId: string,
  actor: string
): Promise<PanicCloneCounts> {
  const out: PanicCloneCounts = { clonesRevoked: 0, cloneSessionsStopped: 0, errors: 0 };

  // Sessions first — INCLUDING orphans whose job already went terminal
  // without tearing the session down (the panic covers those too).
  const sessions = await db.hostedBrowserSession.updateMany({
    where: { userId, status: { in: ["starting", "running"] } },
    data: { status: "stopped", stoppedAt: new Date() },
  });
  out.cloneSessionsStopped += sessions.count;

  const open = await db.cloneJob.findMany({
    where: { userId, status: { notIn: [...CLONE_TERMINAL_STATES] } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  for (const job of open) {
    try {
      await withCloneLock(job.id, async () => {
        const fresh = await loadClone(job.id);
        if (isCloneTerminal(fresh.status)) return;
        const teardown = fresh.destinationDeviceId
          ? await teardownTransport(fresh, fresh.destinationDeviceId)
          : "skipped";
        await terminalEndClone(fresh, "revoked", { actor, reason: "panic_stop", teardown });
        out.clonesRevoked += 1;
      });
    } catch (err) {
      out.errors += 1;
      await recordAgentActionAudit({
        userId,
        pendingActionId: job.pendingActionId ?? undefined,
        action: "browser-clone",
        status: "failed",
        sourceDeviceId: job.sourceDeviceId,
        destinationDeviceId: job.destinationDeviceId ?? undefined,
        cloneId: job.id,
        detail: { reason: `panic_revoke_error: ${errMessage(err)}` },
      });
    }
  }
  return out;
}

/**
 * Owner-scoped record delete (DESIGN §3 "Delete record"). NEVER coerces a
 * live record: only terminal ones may move to `deleted` — that move is the one
 * documented exception outside the transition table (no transition OUT of
 * terminal exists; `deleted` is a tombstone, not a live state). `purgeAfter`
 * is stamped NOW so TASK_112's sweep removes the row on its next pass.
 */
export async function deleteClone(
  cloneId: string,
  userId: string
): Promise<{ cloneId: string; status: CloneState; deleted: boolean; reason?: string }> {
  const job = await db.cloneJob.findUnique({ where: { id: cloneId } });
  // Owner-scoped read: a stranger gets the same "not found" as a missing id.
  if (!job || job.userId !== userId) throw new Error(`clone ${cloneId} not found`);
  if (!isCloneTerminal(job.status)) {
    throw new Error(
      `clone is still ${job.status} — revoke it first (only finished records can be deleted)`
    );
  }
  if (job.status === "deleted") {
    return { cloneId, status: "deleted", deleted: false, reason: "already_deleted" };
  }
  const now = new Date();
  const written = await db.cloneJob.updateMany({
    where: { id: job.id, status: job.status },
    data: { status: "deleted", purgeAfter: now },
  });
  if (written.count === 0) {
    throw new Error(
      `clone_state_conflict: ${job.id} was not ${job.status} (concurrent transition)`
    );
  }
  await auditClone(job, {
    status: "executed",
    detail: {
      from: job.status,
      to: "deleted",
      reason: "owner_deleted_record",
      actor: "owner",
      purgeAfter: now.toISOString(),
    },
  });
  return { cloneId, status: "deleted", deleted: true };
}

// ---------------------------------------------------------------------------
// Read model (what TASK_110's routes and the UI read — never a Prisma row raw)
// ---------------------------------------------------------------------------

export interface CloneDeviceView {
  id: string;
  name: string;
  deviceStatus: string;
  online: boolean;
}

export interface CloneRelayView {
  addr: string;
  status: string;
  lastCheckAt: string | null;
  lastSeenAt: string | null;
  consecutiveFailures: number;
}

export interface CloneSessionView {
  id: string;
  status: string;
  egressMode: string | null;
  startedAt: string;
  lastUsedAt: string | null;
  stoppedAt: string | null;
  expiresAt: string | null;
}

export interface CloneView {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The launch moment = HostedBrowserSession.startedAt (CloneJob has no such column). */
  launchedAt: string | null;
  revokedAt: string | null;
  status: CloneState;
  terminal: boolean;
  launchState: string;
  browser: string;
  profileName: string | null;
  /** Requested-then-confirmed egress policy (overwritten with the used mode at launch). */
  egressMode: string;
  source: CloneDeviceView | null;
  destination: CloneDeviceView | null;
  relay: CloneRelayView | null;
  session: CloneSessionView | null;
  /** Absolute ceiling + current idle budget (stamps on the row). */
  expiresAt: string | null;
  idleExpiresAt: string | null;
  ttlRemainingMs: number | null;
  idleRemainingMs: number | null;
  lastUsedAt: string | null;
  captureExitCode: number | null;
  fileCount: number | null;
  archiveBytes: number | null;
  /** Human-facing failure text (`CloneJob.error`) — evidence, no secrets. */
  error: string | null;
  purgeAfter: string | null;
  pendingActionId: string | null;
}

const cloneViewInclude = {
  sourceDevice: { select: { id: true, name: true, status: true, lastSeenAt: true } },
  destinationDevice: { select: { id: true, name: true, status: true, lastSeenAt: true } },
  relay: {
    select: {
      addr: true,
      status: true,
      lastCheckAt: true,
      lastSeenAt: true,
      consecutiveFailures: true,
    },
  },
  session: {
    select: {
      id: true,
      status: true,
      egressMode: true,
      startedAt: true,
      lastUsedAt: true,
      stoppedAt: true,
      expiresAt: true,
    },
  },
} satisfies Prisma.CloneJobInclude;

type CloneRowForView = Prisma.CloneJobGetPayload<{ include: typeof cloneViewInclude }>;

function toDeviceView(
  device: { id: string; name: string; status: string; lastSeenAt: Date | null } | null
): CloneDeviceView | null {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    deviceStatus: deviceStatus(device),
    online: deviceStatus(device) === "online",
  };
}

function toCloneView(row: CloneRowForView, now = new Date()): CloneView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    launchedAt: row.session?.startedAt.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: row.status as CloneState,
    terminal: isCloneTerminal(row.status),
    launchState: row.launchState,
    browser: row.browser,
    profileName: row.profileName,
    egressMode: row.egressMode,
    source: toDeviceView(row.sourceDevice),
    destination: toDeviceView(row.destinationDevice),
    relay: row.relay
      ? {
          addr: row.relay.addr,
          status: row.relay.status,
          lastCheckAt: row.relay.lastCheckAt?.toISOString() ?? null,
          lastSeenAt: row.relay.lastSeenAt?.toISOString() ?? null,
          consecutiveFailures: row.relay.consecutiveFailures,
        }
      : null,
    session: row.session
      ? {
          id: row.session.id,
          status: row.session.status,
          egressMode: row.session.egressMode,
          startedAt: row.session.startedAt.toISOString(),
          lastUsedAt: row.session.lastUsedAt?.toISOString() ?? null,
          stoppedAt: row.session.stoppedAt?.toISOString() ?? null,
          expiresAt: row.session.expiresAt?.toISOString() ?? null,
        }
      : null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    idleExpiresAt: row.idleExpiresAt?.toISOString() ?? null,
    ttlRemainingMs: row.expiresAt ? row.expiresAt.getTime() - now.getTime() : null,
    idleRemainingMs: row.idleExpiresAt ? row.idleExpiresAt.getTime() - now.getTime() : null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    captureExitCode: row.captureExitCode,
    fileCount: row.fileCount,
    archiveBytes: row.archiveBytes,
    error: row.error,
    purgeAfter: row.purgeAfter?.toISOString() ?? null,
    pendingActionId: row.pendingActionId,
  };
}

/**
 * Owner-scoped read (routes add their own 404 mapping): null when the clone
 * does not exist OR belongs to someone else — never leaks another account's id.
 */
export async function getClone(cloneId: string, userId: string): Promise<CloneView | null> {
  const row = await db.cloneJob.findUnique({
    where: { id: cloneId },
    include: cloneViewInclude,
  });
  if (!row || row.userId !== userId) return null;
  return toCloneView(row);
}

export interface ListClonesFilters {
  status?: string;
  sourceDeviceId?: string;
  destinationDeviceId?: string;
  limit?: number;
}

/** History list for the clone tab — newest first, evidence fields only. */
export async function listClones(
  userId: string,
  filters: ListClonesFilters = {}
): Promise<{ clones: CloneView[] }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db.cloneJob.findMany({
    where: {
      userId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.sourceDeviceId ? { sourceDeviceId: filters.sourceDeviceId } : {}),
      ...(filters.destinationDeviceId ? { destinationDeviceId: filters.destinationDeviceId } : {}),
    },
    include: cloneViewInclude,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const now = new Date();
  return { clones: rows.map((row) => toCloneView(row, now)) };
}

export interface RelayHealthCheckView {
  deviceId: string;
  found: boolean;
  status?: string;
  lastCheckAt?: string | null;
  lastSeenAt?: string | null;
  consecutiveFailures?: number;
  /** Probe outcome as observed NOW (probe transport errors are reported). */
  ok?: boolean;
  error?: string;
}

/**
 * The documented probe→stamp seam: run the transport probe, stamp the
 * RelayHealth row in place (status/lastCheckAt/lastSeenAt/consecutiveFailures),
 * report the result. A probe transport error is reported as `ok:false` after
 * stamping "down" — sweeps want counts, not exceptions.
 */
export async function refreshRelayHealth(deviceId: string): Promise<RelayHealthCheckView> {
  const row = await db.relayHealth.findUnique({ where: { deviceId } });
  if (!row) return { deviceId, found: false };

  let probe: Awaited<ReturnType<typeof probeCloneRelay>> | null = null;
  let error: string | null = null;
  try {
    probe = await probeCloneRelay({ userId: row.userId, sourceDeviceId: deviceId });
  } catch (err) {
    error = errMessage(err);
  }
  await stampRelayHealth(deviceId, probe);

  const fresh = await db.relayHealth.findUnique({ where: { deviceId } });
  return {
    deviceId,
    found: true,
    status: fresh?.status ?? probe?.status ?? "down",
    lastCheckAt: fresh?.lastCheckAt?.toISOString() ?? null,
    lastSeenAt: fresh?.lastSeenAt?.toISOString() ?? null,
    consecutiveFailures: fresh?.consecutiveFailures ?? 0,
    ok: probe?.status === "up",
    ...(error ? { error } : {}),
  };
}

