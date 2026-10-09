import "server-only";

import { db } from "./db";

// ---------------------------------------------------------------------------
// TASK_190 S5 — owner presence (web). Two layers, deliberately:
//
// 1. derivePresence(lastSeenAt, now) — THE pure window math (89 online /
//    91 idle / 301 offline / null → offline). Unit-pinned; never touches db.
// 2. deriveUserPresence(lastActiveAt, lastSeenAt, now) — what the admin chips
//    and the heartbeat BOTH use, so they can never disagree (verify symptom
//    map: "users flickering online↔idle"). The beacon keeps pinging every 60s
//    while the tab is open, so lastSeenAt alone can never go idle; the extra
//    rule set is:
//      • lastSeenAt stale > ONLINE_WINDOW_S  ⇒ offline (tab closed / laptop
//        asleep — pagehide ping lands ≤60s before close, so the chip reads
//        offline within ~2.5min, verify §4.3's "~3min"),
//      • otherwise derive from lastActiveAt (input recency) with its offline
//        branch clamped to idle: pings alive but the user hasn't touched
//        anything ⇒ IDLE, never offline (verify §4.2).
//
// History is TRANSITION-ONLY: heartbeat() writes a UserPresenceEvent only
// when the derived state changes, so a 60s ping storm on a steady state
// adds zero rows (verify §4.2's table check). The heartbeat that discovers a
// gap (prevState offline, lastSeenAt non-null) records BOTH the "offline"
// the chip already showed and the "login" return (verify §4.3/§4.4); a
// never-seen user's first ping records "login" only.
// ---------------------------------------------------------------------------

/** Input older than this ⇒ not "online" anymore (mirrors schema comment). */
export const ONLINE_WINDOW_S = 90;
/** Raw derivePresence idle band; also the beacon's ping cadence upper bound. */
export const IDLE_WINDOW_S = 300;
/** UserPresenceEvent rows older than this are swept daily (retention-sweep). */
export const PRESENCE_EVENT_RETENTION_DAYS = 90;
/** Beacon page strings are truncated at the route AND defensively here. */
export const PRESENCE_PAGE_MAX_CHARS = 120;
/** Drawer cap (verify §4.4: "max 100 rows"). */
export const PRESENCE_LIST_LIMIT = 100;

export type PresenceState = "online" | "idle" | "offline";
export type PresenceEventType = PresenceState | "login" | "logout";

const ageSeconds = (from: Date | null | undefined, now: Date): number | null =>
  from ? (now.getTime() - from.getTime()) / 1000 : null;

/** Pure window math. THE single definition of the three states. */
export function derivePresence(lastSeenAt: Date | null | undefined, now: Date): PresenceState {
  const age = ageSeconds(lastSeenAt, now);
  if (age === null || age < 0) return "offline";
  if (age <= ONLINE_WINDOW_S) return "online";
  if (age <= IDLE_WINDOW_S) return "idle";
  return "offline";
}

/**
 * Chip state for a user with BOTH stamps. See header comment. Exported for
 * lib/admin-devices.ts + the admin pages so every surface derives identically.
 */
export function deriveUserPresence(
  lastActiveAt: Date | null | undefined,
  lastSeenAt: Date | null | undefined,
  now: Date,
): PresenceState {
  const seenAge = ageSeconds(lastSeenAt, now);
  // No heartbeat (yet), or the beacon has been silent past the online window:
  // the tab is gone regardless of how fresh the last input was.
  if (seenAge === null || seenAge < 0 || seenAge > ONLINE_WINDOW_S) return "offline";
  const active = derivePresence(lastActiveAt ?? lastSeenAt, now);
  // Input long stale but pings alive ⇒ idle, not offline (verify §4.2).
  return active === "offline" ? "idle" : active;
}


/**
 * One heartbeat. Updates lastSeenAt + lastSeenPage always; lastActiveAt only
 * when the beacon saw real input since the previous ping (⇒ an inactive ping
 * writes EXACTLY two User columns — verify §4.5) and writes at most two
 * event rows (transition-only). Returns the state AFTER the ping.
 */
export async function heartbeat(
  userId: string,
  page: string | null,
  now: Date,
  opts: { active?: boolean } = {},
): Promise<{ state: PresenceState; transition: PresenceEventType | null }> {
  const active = opts.active === true;
  const cleanPage = page ? page.slice(0, PRESENCE_PAGE_MAX_CHARS) : null;

  const before = await db.user.findUnique({
    where: { id: userId },
    select: { lastSeenAt: true, lastActiveAt: true, lastSeenPage: true },
  });
  // User deleted mid-session — nothing to stamp, and no event either.
  if (!before) return { state: "offline", transition: null };

  const prev = deriveUserPresence(before.lastActiveAt, before.lastSeenAt, now);

  await db.user.update({
    where: { id: userId },
    data: {
      lastSeenAt: now,
      lastSeenPage: cleanPage,
      ...(active ? { lastActiveAt: now } : {}),
    },
  });

  const next = deriveUserPresence(active ? now : before.lastActiveAt, now, now);
  if (next === prev) return { state: next, transition: null };

  if (prev === "offline" && before.lastSeenAt) {
    // A real gap: the chip already showed offline — record it with WHERE the
    // user was when the beacon died, then the return as a fresh login.
    await db.userPresenceEvent.create({
      data: { userId, state: "offline", page: before.lastSeenPage },
    });
    await db.userPresenceEvent.create({
      data: { userId, state: "login", page: cleanPage },
    });
    return { state: next, transition: "login" };
  }

  if (!before.lastSeenAt) {
    // First ping ever for this user — cold start reads as login, not online.
    await db.userPresenceEvent.create({ data: { userId, state: "login", page: cleanPage } });
    return { state: next, transition: "login" };
  }

  await db.userPresenceEvent.create({ data: { userId, state: next, page: cleanPage } });
  return { state: next, transition: next };
}

/**
 * Logout path stamp. Always a row (authenticated → anonymous IS a
 * transition); page = wherever the beacon last saw them. Callers wrap in
 * try/catch — a presence write must never break signing out.
 */
export async function stampLogout(userId: string): Promise<void> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { lastSeenPage: true },
  });
  await db.userPresenceEvent.create({
    data: { userId, state: "logout", page: row?.lastSeenPage ?? null },
  });
}

/** Newest-first history for the admin drawer (7-day window applied by route). */
export async function listUserPresenceEvents(
  userId: string,
  limit = PRESENCE_LIST_LIMIT,
  since?: Date,
): Promise<Array<{ state: string; page: string | null; createdAt: Date }>> {
  return db.userPresenceEvent.findMany({
    where: { userId, ...(since ? { createdAt: { gte: since } } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(PRESENCE_LIST_LIMIT, Math.max(1, Math.round(limit))),
    select: { state: true, page: true, createdAt: true },
  });
}

/**
 * Retention helper for app/api/internal/retention-sweep — deletes events
 * older than PRESENCE_EVENT_RETENTION_DAYS, returns the count (the route
 * logs it inside its own try/catch so a presence failure cannot take the
 * SearchJob sweep down).
 */
export async function sweepPresenceEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PRESENCE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const res = await db.userPresenceEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
