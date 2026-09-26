import "server-only";

import { readFileSync } from "node:fs";
import os from "node:os";

import { db } from "./db";
import { getAdminSettings } from "./admin-settings";
import { listEffectiveEntitlements } from "./entitlements";
// The audit trail writer. Static on purpose: lib/devices.ts imports only
// server-only/@prisma/db at module scope (its clone + governor imports are the
// lazy ones), so this is one-way — and a static edge is what makes the governor
// testable through the house require hook (HOW_WE_MOVE_FAST §4).
import { recordAgentActionAudit } from "./devices";

// ---------------------------------------------------------------------------
// TASK_105 — THE resource governor.
// ---------------------------------------------------------------------------
// ONE server-side place that answers `requestSlot(feature, { userId })` →
// granted | queued(position, eta) | refused. It reads the feature's
// AdminSetting cap (plan CROSS-TRACK RULE 7 — nothing hardwired) AND live
// pressure (RAM used %, swap in use, per-feature running count, CPU load), so
// three features that are each "under their cap" can no longer put the box into
// swap unnoticed.
//
// PRIORITY: premium (tier 5 / a premium entitlement) > standard > trial.
//  - premium bypasses the SOFT queue (a full feature) while the box is healthy;
//  - premium is queued like everyone else once pressure crosses the hard
//    threshold — the limit is the machine, not the plan;
//  - FIFO inside a priority class, and a free/trial request that has waited
//    past governorStarvationPromoteMin is PROMOTED into the premium class, so
//    premium traffic can never starve free users indefinitely.
//
// OFF BY DEFAULT (AdminSetting.governorEnabled = false): every decision falls
// back to the plain cap check today's code already does, with the SAME reason
// strings, and NOTHING is persisted. That is what makes "behaviour is
// byte-identical to today" true rather than aspirational.
//
// The queue itself lives in GovernorQueueEntry so it survives a service
// restart; deploy/governor-sweep.timer POSTs /api/internal/governor-sweep to
// release timed-out entries, promote starved ones and drain the head.

// ---------------------------------------------------------------------------
// Features + priority
// ---------------------------------------------------------------------------

export const GOVERNOR_FEATURES = [
  "dispatchLight",
  "dispatchHeavy",
  "browserSessions",
  "vantraLinks",
  "deviceActions",
  "cloneSessions",
  "hostedPool",
] as const;

export type GovernorFeature = (typeof GOVERNOR_FEATURES)[number];

export function isGovernorFeature(value: unknown): value is GovernorFeature {
  return typeof value === "string" && (GOVERNOR_FEATURES as readonly string[]).includes(value);
}

/** Priority class. Ordering rank is GOVERNOR_PRIORITY_RANK below. */
export type GovernorPriority = "premium" | "standard" | "trial";

export const GOVERNOR_PRIORITIES: readonly GovernorPriority[] = ["premium", "standard", "trial"] as const;

export function isGovernorPriority(value: unknown): value is GovernorPriority {
  return typeof value === "string" && (GOVERNOR_PRIORITIES as readonly string[]).includes(value);
}

/** Normalize a stored/loose priority string to a real class (default standard). */
export function normalizePriority(value: string | null | undefined): GovernorPriority {
  return isGovernorPriority(value) ? value : "standard";
}

/** Premium first (0), then standard (1), then trial (2). */
export const GOVERNOR_PRIORITY_RANK: Record<GovernorPriority, number> = {
  premium: 0,
  standard: 1,
  trial: 2,
};

export function governorPriorityRank(priority: GovernorPriority): number {
  return GOVERNOR_PRIORITY_RANK[priority];
}

/**
 * Pure classification from entitlement facts (lib/entitlements.ts's
 * listEffectiveEntitlements): premium covers everything; a live module grant
 * makes a non-premium payer "standard"; everything else is "trial". The
 * reserved tier 2–4 bands carry no users today (schema comment), so grant
 * presence is the honest signal for "standard".
 */
export function priorityFromFacts(facts: { premium: boolean; hasGrant: boolean }): GovernorPriority {
  if (facts.premium) return "premium";
  if (facts.hasGrant) return "standard";
  return "trial";
}

/** Resolve a user's class from the DB (premium + live grants), applying the
 *  Task 55 lazy premium reversion on the way through. */
export async function resolvePriority(userId: string): Promise<GovernorPriority> {
  const entitlements = await listEffectiveEntitlements(userId);
  return priorityFromFacts({ premium: entitlements.premium, hasGrant: entitlements.keys.length > 0 });
}

/** Pressure levels, logged as transitions by the sweep (normal → warn → hard). */
export type PressureLevel = "normal" | "warn" | "hard";

// ---------------------------------------------------------------------------
// Pressure model — every threshold is an AdminSetting (no hardwired numbers)
// ---------------------------------------------------------------------------

export interface GovernorSettings {
  /** Master switch. false = today's plain cap behaviour, and no queue rows. */
  enabled: boolean;
  /** RAM used % at which premium stops bypassing a full feature. */
  ramWarnPct: number;
  /** RAM used % at which EVERYONE queues (premium included). */
  ramHardPct: number;
  /** Swap in use (MB) that also counts as "full". 0 disables the swap signal. */
  swapHardMb: number;
  /** How long a queued request may wait before the sweep releases it. */
  queueTimeoutSec: number;
  /** Free/trial wait before promotion into the premium class. */
  starvationPromoteMin: number;
}

// Mirrors the AdminSetting defaults in prisma/schema.prisma exactly. This is
// the fallback for a missing/unusable stored value — never a second source of
// truth for a value that is actually set.
export const GOVERNOR_DEFAULTS: GovernorSettings = {
  enabled: false,
  ramWarnPct: 75,
  ramHardPct: 90,
  swapHardMb: 1024,
  queueTimeoutSec: 900,
  starvationPromoteMin: 10,
};

// The structural subset of the AdminSetting row this module needs. Declared
// structurally (like lib/clone-settings.ts) so resolution stays pure/testable
// and this file never has to import Prisma types.
export type GovernorSettingRow = {
  governorEnabled?: boolean | null;
  governorRamWarnPct?: number | null;
  governorRamHardPct?: number | null;
  governorSwapHardMb?: number | null;
  governorQueueTimeoutSec?: number | null;
  governorStarvationPromoteMin?: number | null;
};

/** A whole number >= min; anything else falls back to the documented default. */
function intAtLeast(value: number | null | undefined, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

/** A percentage in 1..100; anything else falls back to the default. */
function pct(value: number | null | undefined, min: number, fallback: number): number {
  const n = intAtLeast(value, min, fallback);
  return Math.min(100, Math.max(1, n));
}

/**
 * Pure mapping from an AdminSetting row (or null) to typed governor settings.
 * `ramHardPct` is clamped to be >= `ramWarnPct`: a warned box that is somehow
 * "harder" than hard would otherwise invert the escalation and let a stressed
 * host keep admitting premium bypasses.
 */
export function resolveGovernorSettings(row: GovernorSettingRow | null | undefined): GovernorSettings {
  const warn = pct(row?.governorRamWarnPct, 1, GOVERNOR_DEFAULTS.ramWarnPct);
  const hard = Math.max(warn, pct(row?.governorRamHardPct, 1, GOVERNOR_DEFAULTS.ramHardPct));
  return {
    enabled: typeof row?.governorEnabled === "boolean" ? row.governorEnabled : GOVERNOR_DEFAULTS.enabled,
    ramWarnPct: warn,
    ramHardPct: hard,
    // 0 is meaningful here ("no swap threshold"), so the floor is 0.
    swapHardMb: intAtLeast(row?.governorSwapHardMb, 0, GOVERNOR_DEFAULTS.swapHardMb),
    queueTimeoutSec: intAtLeast(row?.governorQueueTimeoutSec, 1, GOVERNOR_DEFAULTS.queueTimeoutSec),
    starvationPromoteMin: intAtLeast(
      row?.governorStarvationPromoteMin,
      1,
      GOVERNOR_DEFAULTS.starvationPromoteMin,
    ),
  };
}

/** Reads the singleton AdminSetting row and resolves the pressure model. */
export async function getGovernorSettings(): Promise<GovernorSettings> {
  return resolveGovernorSettings(await getAdminSettings());
}



export interface PressureSnapshot {
  level: PressureLevel;
  /**
   * Whether the host was actually measurable (Linux /proc/meminfo). An
   * unmeasurable host reports "normal" — the governor must never queue work on
   * a machine it cannot observe, and the per-feature caps still apply exactly
   * as they do today.
   */
  measured: boolean;
  ramUsedPct: number;
  ramTotalMb: number;
  ramAvailableMb: number;
  swapUsedMb: number;
  swapTotalMb: number;
  /** 1-minute load average. Observational: it is recorded, never a threshold
   *  (the pressure model has no CPU key, so CPU can never hardwire a block). */
  load1: number;
  cpuCount: number;
  /** Human-readable cause when the level is not "normal"; "" when normal. */
  reason: string;
}

export interface RawMemory {
  totalMb: number;
  availableMb: number;
  swapTotalMb: number;
  swapFreeMb: number;
}

/**
 * Parse Linux /proc/meminfo. Exported pure so the arithmetic is testable
 * without a Linux box. Accepts kB values (the kernel's unit) and returns MB.
 */
export function parseMemInfo(text: string): RawMemory | null {
  const kb: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z()_]+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (m) kb[m[1]] = Number(m[2]);
  }
  if (!Number.isFinite(kb.MemTotal) || kb.MemTotal <= 0) return null;
  // MemAvailable is the honest "what can still be used" number; MemFree on its
  // own overstates pressure (page cache counts as free-but-available). Fall
  // back to MemFree only if the kernel is too old to report MemAvailable.
  const availableKb = Number.isFinite(kb.MemAvailable) ? kb.MemAvailable : kb.MemFree ?? 0;
  return {
    totalMb: kb.MemTotal / 1024,
    availableMb: availableKb / 1024,
    swapTotalMb: (kb.SwapTotal ?? 0) / 1024,
    swapFreeMb: (kb.SwapFree ?? 0) / 1024,
  };
}

function readProcMemInfo(): RawMemory | null {
  try {
    return parseMemInfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pure escalation. `hard` wins over `warn`: once the box is genuinely full the
 * level is hard regardless of which signal tripped.
 */
export function classifyPressure(
  raw: { ramUsedPct: number; swapUsedMb: number },
  settings: Pick<GovernorSettings, "ramWarnPct" | "ramHardPct" | "swapHardMb">,
): { level: PressureLevel; reason: string } {
  const swapTripped = settings.swapHardMb > 0 && raw.swapUsedMb >= settings.swapHardMb;
  const ramHard = raw.ramUsedPct >= settings.ramHardPct;
  if (ramHard || swapTripped) {
    const causes: string[] = [];
    if (ramHard) causes.push(`ram ${raw.ramUsedPct.toFixed(1)}% >= ${settings.ramHardPct}%`);
    if (swapTripped) causes.push(`swap ${Math.round(raw.swapUsedMb)}MB >= ${settings.swapHardMb}MB`);
    return { level: "hard", reason: causes.join(" | ") };
  }
  if (raw.ramUsedPct >= settings.ramWarnPct) {
    return { level: "warn", reason: `ram ${raw.ramUsedPct.toFixed(1)}% >= ${settings.ramWarnPct}%` };
  }
  return { level: "normal", reason: "" };
}

/**
 * Read the host's real pressure. /proc/meminfo first (the production VPS is
 * Linux); `os` as the fallback. On a host with neither (or no swap reporting)
 * the snapshot is `measured: false` → level "normal", so a developer's laptop
 * can never queue a request.
 */
export function readPressure(settings: GovernorSettings): PressureSnapshot {
  const proc = readProcMemInfo();
  const mem: RawMemory = proc ?? {
    totalMb: os.totalmem() / (1024 * 1024),
    availableMb: os.freemem() / (1024 * 1024),
    swapTotalMb: 0,
    swapFreeMb: 0,
  };
  const ramUsedPct =
    mem.totalMb > 0 ? Math.min(100, Math.max(0, (1 - mem.availableMb / mem.totalMb) * 100)) : 0;
  const swapUsedMb = Math.max(0, mem.swapTotalMb - mem.swapFreeMb);
  const measured = proc !== null;
  const classified = measured
    ? classifyPressure({ ramUsedPct, swapUsedMb }, settings)
    : { level: "normal" as PressureLevel, reason: "" };
  return {
    level: classified.level,
    measured,
    ramUsedPct: Number(ramUsedPct.toFixed(2)),
    ramTotalMb: Math.round(mem.totalMb),
    ramAvailableMb: Math.round(mem.availableMb),
    swapUsedMb: Math.round(swapUsedMb),
    swapTotalMb: Math.round(mem.swapTotalMb),
    load1: Number(os.loadavg()[0].toFixed(2)),
    cpuCount: os.cpus().length,
    reason: classified.reason,
  };
}

// ---------------------------------------------------------------------------
// Feature registry — the governor knows every high-RAM consumer
// ---------------------------------------------------------------------------
// Adding a feature is ONE entry here, not a new subsystem. The seeds are the
// mechanisms that already existed (dispatchLight/dispatchHeavy/browserSessions
// = Task 46, vantraLinks/deviceActions = Task 93) plus the Browser Clone pair
// (cloneSessions/hostedPool = Task 97/107). Live counts are the SAME queries the
// admission-control / clone-limits admin routes run, so the panel, the governor
// and the feature's own gate can never disagree about "2 of 3 in use".

export type GovernorCapColumn =
  | "dispatchLightMaxConcurrent"
  | "dispatchHeavyMaxConcurrent"
  | "browserSessionsMaxConcurrent"
  | "vantraLinksMax"
  | "deviceActionsMaxConcurrent"
  | "cloneMaxConcurrent"
  | "hostedPoolSize";

export type GovernorEnabledColumn =
  | "dispatchLightEnabled"
  | "dispatchHeavyEnabled"
  | "browserSessionsEnabled"
  | "vantraLinksEnabled"
  | "deviceActionsEnabled"
  | "cloneSessionsEnabled";

export type GovernorPerUserColumn = "clonePerUserCap";

/** The AdminSetting columns the registry reads (structural subset). */
export type GovernorFeatureRow = {
  [K in GovernorEnabledColumn]?: boolean | null;
} & {
  [K in GovernorCapColumn]?: number | null;
} & {
  [K in GovernorPerUserColumn]?: number | null;
};

function rowBool(
  row: GovernorFeatureRow | null | undefined,
  column: GovernorEnabledColumn,
  fallback: boolean,
): boolean {
  const value = row?.[column];
  return typeof value === "boolean" ? value : fallback;
}

function rowInt(
  row: GovernorFeatureRow | null | undefined,
  column: GovernorCapColumn | GovernorPerUserColumn,
  fallback: number,
): number {
  const value = row?.[column];
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export interface GovernorLiveScope {
  /** When set, count only this user's consumers (for a per-user cap). */
  userId?: string;
}

export interface GovernorFeatureDefinition {
  key: GovernorFeature;
  /** Owner-facing label (same wording as the admin panel). */
  label: string;
  /** AdminSetting column holding the concurrent cap. */
  maxColumn: GovernorCapColumn;
  /** Fallback if the stored cap is missing/unusable (mirrors the schema default). */
  maxDefault: number;
  /** Optional AdminSetting column that pauses the feature outright. */
  enabledColumn?: GovernorEnabledColumn;
  /** Optional AdminSetting column for a per-user cap (clones). */
  perUserColumn?: GovernorPerUserColumn;
  perUserDefault?: number;
  /** Reason string returned while the feature is paused. */
  pausedReason: string;
  /**
   * Can a caller hold a position in the queue? false for caps that waiting
   * cannot relieve (vantraLinks is a TOTAL count of live links, so a request is
   * refused rather than queued — parking it would never make it grantable).
   */
  queueable: boolean;
  /**
   * Does the cap apply while the governor is OFF? true everywhere except the
   * hosted pool, whose size no code enforced before TASK_105 (TASK_118 measured
   * it as a count only) — so with the governor off that feature must keep
   * granting, or enabling nothing would suddenly start blocking clones.
   */
  enforceWhenDisabled?: boolean;
  /** Live count of RAM-holding consumers right now (optionally per user). */
  liveCount: (scope: GovernorLiveScope) => Promise<number>;
}


export const FEATURE_REGISTRY: Record<GovernorFeature, GovernorFeatureDefinition> = {
  dispatchLight: {
    key: "dispatchLight",
    label: "Lead extraction searches — light lane",
    maxColumn: "dispatchLightMaxConcurrent",
    maxDefault: 1,
    enabledColumn: "dispatchLightEnabled",
    pausedReason: "lane_paused",
    queueable: true,
    liveCount: () => db.searchJob.count({ where: { lane: "light", status: "running" } }),
  },
  dispatchHeavy: {
    key: "dispatchHeavy",
    label: "Lead extraction searches — heavy lane",
    maxColumn: "dispatchHeavyMaxConcurrent",
    maxDefault: 1,
    enabledColumn: "dispatchHeavyEnabled",
    pausedReason: "lane_paused",
    queueable: true,
    liveCount: () => db.searchJob.count({ where: { lane: "heavy", status: "running" } }),
  },
  browserSessions: {
    key: "browserSessions",
    label: "Interactive browser sessions",
    maxColumn: "browserSessionsMaxConcurrent",
    maxDefault: 3,
    enabledColumn: "browserSessionsEnabled",
    pausedReason: "browser_sessions_paused",
    queueable: true,
    liveCount: () => db.browserSession.count({ where: { status: { in: ["starting", "running"] } } }),
  },
  vantraLinks: {
    key: "vantraLinks",
    // A total-count cap: "active" = links not revoked.
    label: "Vantra links (assistant device provisioning)",
    maxColumn: "vantraLinksMax",
    maxDefault: 100,
    enabledColumn: "vantraLinksEnabled",
    pausedReason: "vantra_links_disabled",
    queueable: false,
    liveCount: () => db.vantraLink.count({ where: { status: { not: "revoked" } } }),
  },
  deviceActions: {
    key: "deviceActions",
    // Open proposals (requested/approved/executing) — the pool the Task 93 cap counts.
    //
    // HONESTY NOTE: deviceActionsMaxConcurrent is a PER-USER cap and a device
    // action runs on the user's OWN PC through the agent, not on this VPS — so
    // this entry is registered for visibility (the panel's cap/live/queued row)
    // rather than as a pressure admission: `queueable: false`, because waiting in
    // a governor queue cannot relieve a personal proposal limit, and the
    // feature's own gate (lib/vantra-link.ts createDeviceActionProposal) refuses
    // with `device_actions_limit`. The `liveCount` here is the FLEET-WIDE open
    // count — the same number the admission card has always shown for this row.
    label: "Device actions (wake / reboot / scripts)",
    maxColumn: "deviceActionsMaxConcurrent",
    maxDefault: 3,
    enabledColumn: "deviceActionsEnabled",
    pausedReason: "device_actions_disabled",
    queueable: false,
    liveCount: () =>
      db.deviceAction.count({ where: { status: { in: ["requested", "approved", "executing"] } } }),
  },
  cloneSessions: {
    key: "cloneSessions",
    // A live clone is a real Chromium process on the pooled hosted PC.
    label: "Cloned browser sessions",
    maxColumn: "cloneMaxConcurrent",
    maxDefault: 2,
    enabledColumn: "cloneSessionsEnabled",
    perUserColumn: "clonePerUserCap",
    perUserDefault: 1,
    pausedReason: "clone_sessions_paused",
    queueable: true,
    liveCount: (scope) =>
      db.cloneJob.count({
        where: scope.userId ? { userId: scope.userId, status: "active" } : { status: "active" },
      }),
  },
  hostedPool: {
    key: "hostedPool",
    // The pooled hosted PCs actually holding a live session.
    label: "Hosted clone PCs (pooled)",
    maxColumn: "hostedPoolSize",
    maxDefault: 1,
    pausedReason: "hosted_pool_paused",
    queueable: true,
    // Nothing enforced this before TASK_105 (see enforceWhenDisabled above).
    enforceWhenDisabled: false,
    liveCount: async (scope) =>
      (
        await db.hostedBrowserSession.findMany({
          where: {
            status: { in: ["starting", "running"] },
            ...(scope.userId ? { userId: scope.userId } : {}),
          },
          select: { deviceId: true },
          distinct: ["deviceId"],
        })
      ).length,
  },
};


// ---------------------------------------------------------------------------
// Queue order — pure, so FIFO/promotion are provable without a database
// ---------------------------------------------------------------------------

export interface GovernorQueueSortable {
  id: string;
  priority: string;
  requestedAt: Date;
}

/**
 * Effective class for ORDERING. A free/trial request that has waited at least
 * `promoteMin` minutes is treated as premium, so premium traffic can never starve
 * free users indefinitely. The promotion is DERIVED from `requestedAt` (so it is
 * deterministic and survives a restart) and merely STAMPED onto `promotedAt` by
 * the sweep for visibility.
 */
export function effectivePriority(
  entry: Pick<GovernorQueueSortable, "priority" | "requestedAt">,
  promoteMin: number,
  now: Date,
): GovernorPriority {
  const base = normalizePriority(entry.priority);
  if (base === "premium") return "premium";
  const waitedMs = now.getTime() - entry.requestedAt.getTime();
  return waitedMs >= promoteMin * 60_000 ? "premium" : base;
}

/** True when a free/trial entry is being treated as premium because it starved. */
export function isStarved(
  entry: Pick<GovernorQueueSortable, "priority" | "requestedAt">,
  promoteMin: number,
  now: Date,
): boolean {
  return (
    normalizePriority(entry.priority) !== "premium" &&
    effectivePriority(entry, promoteMin, now) === "premium"
  );
}

/**
 * The FIFO order for one feature: effective class first (premium, then
 * standard, then trial), arrival time inside a class. `Array.prototype.sort` is
 * stable, so two entries with the same class and the same timestamp keep their
 * stored order.
 */
export function orderQueue<T extends GovernorQueueSortable>(
  entries: readonly T[],
  promoteMin: number,
  now: Date,
): T[] {
  return [...entries].sort((a, b) => {
    const byClass =
      governorPriorityRank(effectivePriority(a, promoteMin, now)) -
      governorPriorityRank(effectivePriority(b, promoteMin, now));
    if (byClass !== 0) return byClass;
    return a.requestedAt.getTime() - b.requestedAt.getTime();
  });
}

/** 1-based rank of `id` in the ordered queue, or 0 when it is not queued. */
export function queuePosition(ordered: readonly { id: string }[], id: string): number {
  const index = ordered.findIndex((entry) => entry.id === id);
  return index < 0 ? 0 : index + 1;
}

/**
 * Coarse wait estimate in seconds. There is no recorded slot DURATION anywhere
 * (a clone can run for the full TTL), so this deliberately spreads the
 * admin-tunable `queueTimeoutSec` across the feature's cap: a queue one
 * "capacity wave" deep is expected to clear inside one timeout window. The UI
 * leads with `position` (the honest number) and treats this as an estimate.
 */
export function estimateEtaSeconds(position: number, cap: number, queueTimeoutSec: number): number {
  if (position <= 0) return 0;
  return Math.round((position / Math.max(1, cap)) * queueTimeoutSec);
}


// ---------------------------------------------------------------------------
// requestSlot — THE admission decision
// ---------------------------------------------------------------------------

export interface SlotRequest {
  userId: string;
  /** Class override; default is resolved from the user's entitlements. */
  priority?: GovernorPriority;
  /**
   * The caller's stable handle (e.g. a CloneJob id). Repeated requests with the
   * same (feature, ref) share ONE queue row, so FIFO position stays stable
   * across the polls a clone pipeline makes. Omit when the caller has no
   * durable id yet.
   */
  ref?: string;
  /**
   * Injected pressure snapshot. Production callers omit it (the live host is
   * read); tests and the diagnostic surface supply it so a level can be forced.
   */
  pressure?: PressureSnapshot;
  now?: Date;
}

export interface SlotGranted {
  status: "granted";
  feature: GovernorFeature;
  priority: GovernorPriority;
  /** True when a full feature was admitted anyway because the box is healthy
   *  and the request is premium (the soft-queue bypass). */
  bypassed: boolean;
}

export interface SlotQueued {
  status: "queued";
  feature: GovernorFeature;
  priority: GovernorPriority;
  /** 1-based place in line — the number the UI shows. */
  position: number;
  /** Coarse estimate in seconds (see estimateEtaSeconds). */
  etaSeconds: number;
  reason: string;
  /** True when a GovernorQueueEntry row actually holds this place. false is the
   *  governor-off path (and a paused feature), where nothing is written. */
  persisted: boolean;
}

export interface SlotRefused {
  status: "refused";
  feature: GovernorFeature;
  priority: GovernorPriority;
  reason: string;
}

export type SlotDecision = SlotGranted | SlotQueued | SlotRefused;

/** One place to build every "not granted" answer, so queueable vs not is never
 *  re-decided at a call site. */
function blocked(
  def: GovernorFeatureDefinition,
  feature: GovernorFeature,
  priority: GovernorPriority,
  reason: string,
  position = 0,
  etaSeconds = 0,
  persisted = false,
): SlotDecision {
  if (!def.queueable) return { status: "refused", feature, priority, reason };
  return { status: "queued", feature, priority, reason, position, etaSeconds, persisted };
}

function granted(feature: GovernorFeature, priority: GovernorPriority, bypassed = false): SlotGranted {
  return { status: "granted", feature, priority, bypassed };
}

async function markGranted(entryId: string, now: Date): Promise<void> {
  await db.governorQueueEntry.update({
    where: { id: entryId },
    data: { status: "granted", grantedAt: now, position: 0 },
  });
}

/**
 * Ask for one slot on `feature`.
 *
 *   granted               → proceed now (existing behaviour for that feature)
 *   queued(position, eta) → wait; the caller keeps its own job in a waiting
 *                           state and asks again (or lets the sweep drain it)
 *   refused               → cannot wait its way out of this (a paused feature, or
 *                           a total-count cap); the caller surfaces the reason
 *
 * With the governor OFF this is exactly the cap check the feature already did,
 * with the same reason strings and no persistence — see the header comment.
 */
export async function requestSlot(
  feature: GovernorFeature,
  req: SlotRequest,
): Promise<SlotDecision> {
  const def = FEATURE_REGISTRY[feature];
  const now = req.now ?? new Date();
  const row = await getAdminSettings();
  const priority = req.priority ?? (await resolvePriority(req.userId));

  // Pause first: a paused feature must not even take a place in line, exactly
  // as the feature's own gate does today.
  if (def.enabledColumn && !rowBool(row, def.enabledColumn, true)) {
    return blocked(def, feature, priority, def.pausedReason);
  }

  const settings = resolveGovernorSettings(row);
  const cap = rowInt(row, def.maxColumn, def.maxDefault);
  const perUserCap = def.perUserColumn
    ? rowInt(row, def.perUserColumn, def.perUserDefault ?? 1)
    : null;

  // ---- Governor OFF (the default): the plain cap check, nothing persisted ----
  if (!settings.enabled) {
    if (def.enforceWhenDisabled ?? true) {
      const live = await def.liveCount({});
      if (live >= cap) return blocked(def, feature, priority, `at_capacity (${live}/${cap})`);
    }
    if (perUserCap !== null) {
      const perUser = await def.liveCount({ userId: req.userId });
      if (perUser >= perUserCap) {
        return blocked(def, feature, priority, `per_user_cap (${perUser}/${perUserCap})`);
      }
    }
    return granted(feature, priority);
  }


  // ---- Governor ON ----
  // Idempotency FIRST: a request that was already ADMITTED for this ref keeps its
  // admission, before any count is re-read. The clone pipeline asks three times
  // for the same ref (create → capture → launch); once the slot is held, a
  // per-user cap that has since filled up (the clone is now live) must not turn
  // the clone's own admission into "you already have a live clone".
  const prior = req.ref
    ? await db.governorQueueEntry.findFirst({
        where: { feature, ref: req.ref, status: { in: ["queued", "granted"] } },
        orderBy: { requestedAt: "desc" },
      })
    : null;
  if (prior?.status === "granted") return granted(feature, priority);

  const live = await def.liveCount({});
  const perUserLive = perUserCap !== null ? await def.liveCount({ userId: req.userId }) : 0;
  const pressure = req.pressure ?? readPressure(settings);

  // A personal cap is not something the machine can relieve by waiting, but the
  // caller's own session ending can — so it queues rather than refusing.
  if (perUserCap !== null && perUserLive >= perUserCap) {
    return blocked(def, feature, priority, `per_user_cap (${perUserLive}/${perUserCap})`);
  }

  const waiting = await db.governorQueueEntry.findMany({ where: { feature, status: "queued" } });
  const rivals = waiting.filter((entry) => entry.id !== prior?.id);
  const orderedRivals = orderQueue(rivals, settings.starvationPromoteMin, now);
  const newRank = governorPriorityRank(priority);
  // Everyone whose effective class is at least as good as this request's is
  // ahead of it: a fresh request cannot jump its own class or a better one.
  const ahead = orderedRivals.filter(
    (entry) =>
      governorPriorityRank(effectivePriority(entry, settings.starvationPromoteMin, now)) <= newRank,
  );

  const full = live >= cap;
  const hard = pressure.level === "hard";
  // Premium bypasses the SOFT queue only while the box is HEALTHY (normal).
  const bypass = !hard && pressure.level === "normal" && priority === "premium";

  // A non-queueable cap (a total count) can never be relieved by waiting.
  if (!def.queueable) {
    if (hard) return blocked(def, feature, priority, `hard_pressure (${pressure.reason})`);
    if (full) return blocked(def, feature, priority, `at_capacity (${live}/${cap})`);
    return granted(feature, priority);
  }

  if (!hard && ahead.length === 0 && (!full || bypass)) {
    if (prior) await markGranted(prior.id, now);
    return granted(feature, priority, full && bypass);
  }

  const reason = hard
    ? `hard_pressure (${pressure.reason})`
    : full
      ? `at_capacity (${live}/${cap})`
      : `fifo_wait (${ahead.length} ahead)`;

  const entry =
    prior ??
    (await db.governorQueueEntry.create({
      data: {
        feature,
        userId: req.userId,
        ref: req.ref ?? null,
        priority,
        status: "queued",
        reason,
        requestedAt: now,
        // Stamped at enqueue so the sweep needs no settings read to find expired rows.
        expiresAt: new Date(now.getTime() + settings.queueTimeoutSec * 1000),
      },
    }));

  // Refresh the visible rank over the WHOLE queue (promotions included).
  const fullQueue = orderQueue([...rivals, entry], settings.starvationPromoteMin, now);
  const position = queuePosition(fullQueue, entry.id);
  await db.governorQueueEntry.update({ where: { id: entry.id }, data: { position, reason } });

  return {
    status: "queued",
    feature,
    priority,
    reason,
    position,
    etaSeconds: estimateEtaSeconds(position, cap, settings.queueTimeoutSec),
    persisted: true,
  };
}


// ---------------------------------------------------------------------------
// Draining + the sweep
// ---------------------------------------------------------------------------

export interface DrainResult {
  feature: GovernorFeature;
  granted: number;
  promoted: number;
  level: PressureLevel;
}

/**
 * Grant as many waiting requests as the feature can take right now, head first.
 *
 * A blocked head stops the whole line (`break`) — that is FIFO: letting the
 * second entry through while the first waits for the same slot would let a
 * premium request overtake a standard one. A user sitting at their OWN per-user
 * cap is skipped (`continue`) because nobody else's grant depends on it.
 */
async function drainWithContext(
  def: GovernorFeatureDefinition,
  row: GovernorFeatureRow,
  settings: GovernorSettings,
  pressure: PressureSnapshot,
  now: Date,
): Promise<{ granted: number; promoted: number }> {
  if (!def.queueable) return { granted: 0, promoted: 0 };
  const cap = rowInt(row, def.maxColumn, def.maxDefault);
  const perUserCap = def.perUserColumn
    ? rowInt(row, def.perUserColumn, def.perUserDefault ?? 1)
    : null;
  const waiting = await db.governorQueueEntry.findMany({
    where: { feature: def.key, status: "queued" },
  });
  const ordered = orderQueue(waiting, settings.starvationPromoteMin, now);
  let live = await def.liveCount({});
  let granted = 0;
  let promoted = 0;

  for (const entry of ordered) {
    const eff = effectivePriority(entry, settings.starvationPromoteMin, now);
    const full = live >= cap;
    const bypass = pressure.level === "normal" && eff === "premium";
    if (full && !bypass) break;
    if (perUserCap !== null) {
      const perUser = await def.liveCount({ userId: entry.userId });
      if (perUser >= perUserCap) continue;
    }
    if (!entry.promotedAt && isStarved(entry, settings.starvationPromoteMin, now)) {
      await db.governorQueueEntry.update({ where: { id: entry.id }, data: { promotedAt: now } });
      promoted += 1;
    }
    await markGranted(entry.id, now);
    live += 1;
    granted += 1;
  }
  return { granted, promoted };
}

/** Drain one feature (used by callers that just freed a slot). */
export async function drainQueue(
  feature: GovernorFeature,
  opts?: { pressure?: PressureSnapshot; now?: Date },
): Promise<DrainResult> {
  const now = opts?.now ?? new Date();
  const def = FEATURE_REGISTRY[feature];
  const row = await getAdminSettings();
  const settings = resolveGovernorSettings(row);
  const pressure = opts?.pressure ?? readPressure(settings);
  if (!settings.enabled || pressure.level === "hard") {
    return { feature, granted: 0, promoted: 0, level: pressure.level };
  }
  const result = await drainWithContext(def, row, settings, pressure, now);
  return { feature, granted: result.granted, promoted: result.promoted, level: pressure.level };
}

export function isPressureLevel(value: unknown): value is PressureLevel {
  return value === "normal" || value === "warn" || value === "hard";
}

/**
 * Record normal → warn → hard → normal transitions on the audit trail
 * (AgentActionAudit, action "resource-governor"). The previous level is read
 * back from the newest such row, so no extra state table is needed and the
 * history is the trail. Returns whether a row was written.
 */
async function logPressureTransition(
  pressure: PressureSnapshot,
  settings: GovernorSettings,
): Promise<{ from: PressureLevel | null; to: PressureLevel; logged: boolean }> {
  const last = await db.agentActionAudit.findFirst({
    where: { action: "resource-governor" },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  });
  const detail = last?.detail as { level?: unknown } | null | undefined;
  const previous = isPressureLevel(detail?.level) ? detail.level : null;
  if (previous === pressure.level) {
    return { from: previous, to: pressure.level, logged: false };
  }
  // First ever run in the steady state: nothing to say.
  if (previous === null && pressure.level === "normal") {
    return { from: null, to: "normal", logged: false };
  }
  await recordAgentActionAudit({
    action: "resource-governor",
    status: "executed",
    detail: {
      level: pressure.level,
      previous,
      ramUsedPct: pressure.ramUsedPct,
      ramTotalMb: pressure.ramTotalMb,
      ramAvailableMb: pressure.ramAvailableMb,
      swapUsedMb: pressure.swapUsedMb,
      swapTotalMb: pressure.swapTotalMb,
      load1: pressure.load1,
      cpuCount: pressure.cpuCount,
      measured: pressure.measured,
      reason: pressure.reason,
      ramWarnPct: settings.ramWarnPct,
      ramHardPct: settings.ramHardPct,
      swapHardMb: settings.swapHardMb,
    },
  });
  return { from: previous, to: pressure.level, logged: true };
}


export interface GovernorSweepResult {
  enabled: boolean;
  level: PressureLevel;
  pressure: PressureSnapshot;
  /** Queued entries released because they waited past governorQueueTimeoutSec. */
  expired: number;
  /** Starved free/trial entries promoted into the premium class this tick. */
  promoted: number;
  /** Admission markers closed because the grant is no longer meaningful. */
  released: number;
  /** Waiters granted this tick. */
  granted: number;
  /** Grants per feature (only features that granted anything). */
  byFeature: Record<string, number>;
  /** Waiters still queued after the tick. */
  queued: number;
  transitions: { from: PressureLevel | null; to: PressureLevel; logged: boolean };
}

/**
 * The sweep the systemd timer drives: release timed-out waiters, promote starved
 * ones, drain the heads, and log pressure transitions. Every phase is
 * independently idempotent, so a second run in the same minute is a clean no-op.
 *
 * Housekeeping (timeout + release) runs even when the governor is OFF, so rows
 * left behind by switching it off cannot wedge the table forever.
 */
export async function sweepGovernor(opts?: {
  pressure?: PressureSnapshot;
  now?: Date;
}): Promise<GovernorSweepResult> {
  const now = opts?.now ?? new Date();
  const row = await getAdminSettings();
  const settings = resolveGovernorSettings(row);
  const pressure = opts?.pressure ?? readPressure(settings);

  const expiredRes = await db.governorQueueEntry.updateMany({
    where: { status: "queued", expiresAt: { lt: now } },
    data: { status: "expired", expiredAt: now, reason: "queue_timeout" },
  });

  // A grant is only meaningful while the request it admitted is starting up;
  // closing stale ones bounds the table without touching the audit trail.
  const releasedRes = await db.governorQueueEntry.updateMany({
    where: {
      status: "granted",
      grantedAt: { lt: new Date(now.getTime() - settings.queueTimeoutSec * 1000) },
    },
    data: { status: "released" },
  });

  let promoted = 0;
  const byFeature: Record<string, number> = {};
  let granted = 0;

  if (settings.enabled) {
    const promotedRes = await db.governorQueueEntry.updateMany({
      where: {
        status: "queued",
        promotedAt: null,
        priority: { not: "premium" },
        requestedAt: { lt: new Date(now.getTime() - settings.starvationPromoteMin * 60_000) },
      },
      data: { promotedAt: now },
    });
    promoted += promotedRes.count;

    // Hard pressure freezes the line: nothing new starts while the box is full.
    if (pressure.level !== "hard") {
      for (const feature of GOVERNOR_FEATURES) {
        const result = await drainWithContext(
          FEATURE_REGISTRY[feature],
          row,
          settings,
          pressure,
          now,
        );
        promoted += result.promoted;
        granted += result.granted;
        if (result.granted > 0) byFeature[feature] = result.granted;
      }
    }
  }

  const queued = await db.governorQueueEntry.count({ where: { status: "queued" } });
  const transitions = await logPressureTransition(pressure, settings);

  return {
    enabled: settings.enabled,
    level: pressure.level,
    pressure,
    expired: expiredRes.count,
    promoted,
    released: releasedRes.count,
    granted,
    byFeature,
    queued,
    transitions,
  };
}

/**
 * Withdraw waiting requests (status → cancelled). Used by the global panic
 * switch (plan CROSS-TRACK RULE 6) and available to any caller that aborts its
 * own request. Returns how many were cancelled. Granted entries are left alone:
 * they describe something already admitted, which the caller must stop instead.
 */
export async function cancelQueuedSlots(opts: {
  userId?: string;
  feature?: GovernorFeature;
  ref?: string;
}): Promise<number> {
  const result = await db.governorQueueEntry.updateMany({
    where: {
      status: "queued",
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.feature ? { feature: opts.feature } : {}),
      ...(opts.ref ? { ref: opts.ref } : {}),
    },
    data: { status: "cancelled", expiredAt: new Date(), reason: "cancelled" },
  });
  return result.count;
}


// ---------------------------------------------------------------------------
// Admin read model — cap, live count and QUEUED count per feature
// ---------------------------------------------------------------------------

export interface GovernorFeatureStatus {
  key: GovernorFeature;
  label: string;
  queueable: boolean;
  enabled: boolean;
  cap: number;
  live: number;
  queued: number;
  perUserCap: number | null;
}

/** Every feature with its cap, live count and queued count (admin panel source). */
export async function getGovernorFeatureStatuses(): Promise<GovernorFeatureStatus[]> {
  const row = await getAdminSettings();
  const out: GovernorFeatureStatus[] = [];
  for (const key of GOVERNOR_FEATURES) {
    const def = FEATURE_REGISTRY[key];
    out.push({
      key,
      label: def.label,
      queueable: def.queueable,
      enabled: def.enabledColumn ? rowBool(row, def.enabledColumn, true) : true,
      cap: rowInt(row, def.maxColumn, def.maxDefault),
      live: await def.liveCount({}),
      queued: await db.governorQueueEntry.count({ where: { feature: key, status: "queued" } }),
      perUserCap: def.perUserColumn
        ? rowInt(row, def.perUserColumn, def.perUserDefault ?? 1)
        : null,
    });
  }
  return out;
}

export interface GovernorView {
  settings: GovernorSettings;
  pressure: PressureSnapshot;
  features: GovernorFeatureStatus[];
  queuedTotal: number;
}

/**
 * Live place-in-line for a set of caller handles (`ref`), so a list view can show
 * "2 ahead of you" that updates itself as the queue drains. Computed from the
 * same ordering the sweep grants with, so the number a user sees can never drift
 * from the order the governor will actually use. Entries that are not still
 * waiting (granted, expired, cancelled, or never queued) are simply absent.
 */
export async function getQueuePositions(
  feature: GovernorFeature,
  refs: readonly string[],
): Promise<Map<string, { position: number; etaSeconds: number }>> {
  const out = new Map<string, { position: number; etaSeconds: number }>();
  const wanted = [...new Set(refs.filter((ref) => typeof ref === "string" && ref.length > 0))];
  if (wanted.length === 0) return out;

  const row = await getAdminSettings();
  const mine = await db.governorQueueEntry.findMany({
    where: { feature, status: "queued", ref: { in: wanted } },
  });
  if (mine.length === 0) return out;

  const settings = resolveGovernorSettings(row);
  const cap = rowInt(row, FEATURE_REGISTRY[feature].maxColumn, FEATURE_REGISTRY[feature].maxDefault);
  const now = new Date();
  // The WHOLE waiting line, so a position means the same thing here as it does
  // in requestSlot (a competitor's arrival cannot silently renumber a user).
  const all = await db.governorQueueEntry.findMany({ where: { feature, status: "queued" } });
  const ordered = orderQueue(all, settings.starvationPromoteMin, now);
  for (const entry of mine) {
    if (!entry.ref) continue;
    const position = queuePosition(ordered, entry.id);
    if (position > 0) {
      out.set(entry.ref, {
        position,
        etaSeconds: estimateEtaSeconds(position, cap, settings.queueTimeoutSec),
      });
    }
  }
  return out;
}

/** One read for the admin surface: thresholds, live pressure, per-feature counts. */
export async function getGovernorView(): Promise<GovernorView> {
  const row = await getAdminSettings();
  const settings = resolveGovernorSettings(row);
  const features = await getGovernorFeatureStatuses();
  return {
    settings,
    pressure: readPressure(settings),
    features,
    queuedTotal: features.reduce((total, feature) => total + feature.queued, 0),
  };
}

