import "server-only";
import { getAdminSettings } from "./admin-settings";

// TASK_107 (bit B1) deliverable 4 — the ONE typed reader for the Browser Clone
// admin limits. TASK_109 (orchestrator), TASK_110 (gating) and TASK_112 (sweep)
// import from here and never read AdminSetting columns/strings directly, so a key
// rename or a clamping rule changes in exactly one place (CROSS-TRACK RULE 7: no
// hardwired limits anywhere in the clone pipeline).
//
// The row comes from getAdminSettings() (upsert-into-singleton, so a missing row
// is created with the schema defaults). Values are sanitised on read: an
// unusable stored number falls back to the documented default rather than
// silently disabling a guard (a cap of 0 would otherwise read as "paused").

export type CloneSettings = {
  /** Master on/off. A pause blocks NEW clone starts; live sessions are untouched. */
  enabled: boolean;
  /** Concurrent live clone sessions across the whole engine. */
  maxConcurrent: number;
  /** Of those, how many any one user may hold at once. */
  perUserCap: number;
  /** Pooled hosted clone PCs provisioned to serve sessions. */
  hostedPoolSize: number;
  /** Idle TTL in minutes before a session is torn down. */
  idleTtlMinutes: number;
  /** Absolute ceiling in minutes, even while the session is in use (480 = 8 h). */
  hardTtlMinutes: number;
  /** Inactive (terminal) clone-record purge window in days. */
  purgeAfterDays: number;
  /** Direct egress (`--proxy-optional`) also requires the premium entitlement. */
  directEgressPremiumOnly: boolean;
  /** Relay mode fails closed when the relay is down (no silent IP switch). */
  relayRequired: boolean;
};

// Mirrors the AdminSetting defaults in prisma/schema.prisma exactly. This is the
// fallback for a missing/unusable stored value — never a second source of truth
// for a value that is actually set.
export const CLONE_SETTING_DEFAULTS: CloneSettings = {
  enabled: true,
  maxConcurrent: 2,
  perUserCap: 1,
  hostedPoolSize: 1,
  idleTtlMinutes: 60,
  hardTtlMinutes: 480,
  purgeAfterDays: 30,
  directEgressPremiumOnly: true,
  relayRequired: true,
};

// The structural subset of the AdminSetting row this module needs. Declared
// structurally so resolution stays pure/testable and this file never has to
// import Prisma types.
export type CloneSettingRow = {
  cloneSessionsEnabled?: boolean | null;
  cloneMaxConcurrent?: number | null;
  clonePerUserCap?: number | null;
  hostedPoolSize?: number | null;
  cloneIdleTtlMinutes?: number | null;
  cloneHardTtlMinutes?: number | null;
  clonePurgeAfterDays?: number | null;
  cloneDirectEgressPremiumOnly?: boolean | null;
  cloneRelayRequired?: boolean | null;
};

/** A limit must be a whole number >= 1; anything else falls back to the default. */
function positiveInt(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function bool(value: boolean | null | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Pure mapping from an AdminSetting row (or null) to typed settings. No DB. */
export function resolveCloneSettings(
  row: CloneSettingRow | null | undefined
): CloneSettings {
  return {
    enabled: bool(row?.cloneSessionsEnabled, CLONE_SETTING_DEFAULTS.enabled),
    maxConcurrent: positiveInt(row?.cloneMaxConcurrent, CLONE_SETTING_DEFAULTS.maxConcurrent),
    perUserCap: positiveInt(row?.clonePerUserCap, CLONE_SETTING_DEFAULTS.perUserCap),
    hostedPoolSize: positiveInt(row?.hostedPoolSize, CLONE_SETTING_DEFAULTS.hostedPoolSize),
    idleTtlMinutes: positiveInt(row?.cloneIdleTtlMinutes, CLONE_SETTING_DEFAULTS.idleTtlMinutes),
    hardTtlMinutes: positiveInt(row?.cloneHardTtlMinutes, CLONE_SETTING_DEFAULTS.hardTtlMinutes),
    purgeAfterDays: positiveInt(row?.clonePurgeAfterDays, CLONE_SETTING_DEFAULTS.purgeAfterDays),
    directEgressPremiumOnly: bool(
      row?.cloneDirectEgressPremiumOnly,
      CLONE_SETTING_DEFAULTS.directEgressPremiumOnly
    ),
    relayRequired: bool(row?.cloneRelayRequired, CLONE_SETTING_DEFAULTS.relayRequired),
  };
}

/** The runtime reader every later clone bit uses (TASK_109/110/112, TASK_105). */
export async function getCloneSettings(): Promise<CloneSettings> {
  return resolveCloneSettings(await getAdminSettings());
}

/**
 * The TTL pair stamped onto a job/session when it starts. Stamped (not re-read)
 * on purpose: a later admin change must never retroactively expire something
 * already running (same rule as AdminSetting.cloneIdleTtlMinutes in the schema).
 */
export function cloneTtlDeadlines(
  settings: CloneSettings,
  from: Date = new Date()
): { idleExpiresAt: Date; expiresAt: Date } {
  return {
    idleExpiresAt: new Date(from.getTime() + settings.idleTtlMinutes * 60_000),
    expiresAt: new Date(from.getTime() + settings.hardTtlMinutes * 60_000),
  };
}
