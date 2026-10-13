// TASK_156 C2a (PLAN_TASK_156 §6 LabRange comment, §8.5) — the range lifecycle
// state machine. Clone-style forward-only: every transition is declared, a
// backward move or a skipped state is an ERROR rather than a silent update, and
// the terminal states are terminal. The one "verified" concept here —
// `teardownVerifiedAt` — can only be set by a teardown that was actually
// verified; an unverified teardown FAILS the range instead of faking the flag
// (§8.5: a failed teardown raises an incident).

import "server-only";

import { db } from "@/lib/db";

export const LAB_RANGE_STATES = ["pending", "provisioning", "active", "tearing_down", "torn_down", "failed"] as const;
export type LabRangeState = (typeof LAB_RANGE_STATES)[number];

/** Forward-only map: from-state → the states it may move to. */
const ALLOWED_TRANSITIONS: Record<LabRangeState, readonly LabRangeState[]> = {
  pending: ["provisioning", "failed"],
  provisioning: ["active", "failed"],
  active: ["tearing_down", "failed"],
  tearing_down: ["torn_down", "failed"],
  torn_down: [],
  failed: [],
};

export class RangeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RangeTransitionError";
  }
}

/** Create the range row in `pending`. The consent row in force is recorded as provenance. */
export async function createLabRange(params: { userId: string; scenarioId: string; consentId: string | null }) {
  return db.labRange.create({ data: { userId: params.userId, scenarioId: params.scenarioId, consentId: params.consentId, state: "pending" } });
}

/** The single transition primitive. Refuses illegal moves with the state pair in the message. */
export async function transitionRange(
  rangeId: string,
  to: LabRangeState,
  data: { error?: string; ttlExpiresAt?: Date; teardownVerifiedAt?: Date } = {},
) {
  const range = await db.labRange.findUniqueOrThrow({ where: { id: rangeId } });
  const from = range.state as LabRangeState;
  if (!(LAB_RANGE_STATES as readonly string[]).includes(from) || !ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new RangeTransitionError(`illegal_range_transition (${from} -> ${to})`);
  }
  return db.labRange.update({ where: { id: rangeId }, data: { state: to, ...data } });
}

export async function provisionRange(rangeId: string) {
  return transitionRange(rangeId, "provisioning");
}

/** Enter `active` with the HARD TTL stamped (§8.3 — the clock starts here). */
export async function activateRange(rangeId: string, ttlMinutes: number) {
  return transitionRange(rangeId, "active", { ttlExpiresAt: new Date(Date.now() + ttlMinutes * 60_000) });
}

export async function beginTeardown(rangeId: string) {
  return transitionRange(rangeId, "tearing_down");
}

/**
 * Finish a teardown. `verified: true` is the ONLY way to reach `torn_down`
 * with a stamp; an unverified teardown moves the range to `failed` (incident
 * per §8.5) and throws — never a silent "success".
 */
export async function completeTeardown(rangeId: string, verified: boolean) {
  if (!verified) {
    await transitionRange(rangeId, "failed", { error: "teardown_unverified" });
    throw new RangeTransitionError("teardown_unverified (range marked failed; incident per §8.5)");
  }
  return transitionRange(rangeId, "torn_down", { teardownVerifiedAt: new Date() });
}

export async function failRange(rangeId: string, error: string) {
  return transitionRange(rangeId, "failed", { error });
}
